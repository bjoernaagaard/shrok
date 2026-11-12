import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { typed } from "./output.ts";
import type { ShrokTool } from "./policy.ts";

const TIMEOUT_MS = 20_000;
const SECONDS_PER_MINUTE = 60;
const METRES_PER_KM = 1000;

// Nominatim's usage policy asks every client to name itself.
const USER_AGENT =
  "Shrok personal assistant (https://github.com/bjoernaagaard/shrok)";

/** WMO weather codes, as Open-Meteo reports them. */
const WEATHER = new Map([
  [0, "clear"],
  [1, "mainly clear"],
  [2, "partly cloudy"],
  [3, "overcast"],
  [45, "fog"],
  [48, "freezing fog"],
  [51, "light drizzle"],
  [53, "drizzle"],
  [55, "heavy drizzle"],
  [56, "freezing drizzle"],
  [57, "heavy freezing drizzle"],
  [61, "light rain"],
  [63, "rain"],
  [65, "heavy rain"],
  [66, "freezing rain"],
  [67, "heavy freezing rain"],
  [71, "light snow"],
  [73, "snow"],
  [75, "heavy snow"],
  [77, "snow grains"],
  [80, "light showers"],
  [81, "showers"],
  [82, "heavy showers"],
  [85, "snow showers"],
  [86, "heavy snow showers"],
  [95, "thunderstorm"],
  [96, "thunderstorm with hail"],
  [99, "thunderstorm with heavy hail"],
]);

const getJson = async <T extends TSchema>(
  schema: T,
  url: URL
): Promise<Static<T>> => {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${url.host} answered ${response.status}.`);
  }

  return Value.Parse(schema, await response.json());
};

const PlaceResponse = Type.Array(
  Type.Object({
    display_name: Type.String(),
    lat: Type.String(),
    lon: Type.String(),
  })
);

interface Place {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** A place or address as coordinates, from OpenStreetMap's Nominatim. */
const findPlace = async (query: string): Promise<Place> => {
  const url = new URL("https://nominatim.openstreetmap.org/search");

  url.search = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    q: query,
  }).toString();

  const [found] = await getJson(PlaceResponse, url);

  if (found === undefined) {
    throw new Error(`OpenStreetMap does not know the place "${query}".`);
  }

  return {
    latitude: Number(found.lat),
    longitude: Number(found.lon),
    name: found.display_name,
  };
};

const ForecastResponse = Type.Object({
  current: Type.Object({
    temperature_2m: Type.Number(),
    weather_code: Type.Integer(),
    wind_speed_10m: Type.Number(),
  }),
  daily: Type.Object({
    precipitation_probability_max: Type.Array(
      Type.Union([Type.Number(), Type.Null()])
    ),
    precipitation_sum: Type.Array(Type.Number()),
    temperature_2m_max: Type.Array(Type.Number()),
    temperature_2m_min: Type.Array(Type.Number()),
    time: Type.Array(Type.String()),
    weather_code: Type.Array(Type.Integer()),
    wind_speed_10m_max: Type.Array(Type.Number()),
  }),
});

const WeatherOutput = Type.Object({
  days: Type.Array(
    Type.Object({
      date: Type.String(),
      highC: Type.Number(),
      lowC: Type.Number(),
      rainChancePercent: Type.Union([Type.Number(), Type.Null()]),
      rainMm: Type.Number(),
      sky: Type.String(),
      windMaxKmh: Type.Number(),
    })
  ),
  now: Type.Object({
    sky: Type.String(),
    temperatureC: Type.Number(),
    windKmh: Type.Number(),
  }),
  place: Type.String(),
});

const RouteResponse = Type.Object({
  code: Type.String(),
  routes: Type.Optional(
    Type.Array(
      Type.Object({ distance: Type.Number(), duration: Type.Number() })
    )
  ),
});

const TravelOutput = Type.Object({
  from: Type.String(),
  kilometres: Type.Number(),
  minutes: Type.Number(),
  mode: Type.String(),
  to: Type.String(),
});

/** OpenStreetMap's routing service for Germany's FOSSGIS runs one server per way of travel. */
const ROUTERS = new Map([
  ["bike", "routed-bike"],
  ["car", "routed-car"],
  ["foot", "routed-foot"],
]);

export const createPlaceTools = (): ShrokTool[] => [
  {
    flow: true,
    phrase: "checking the weather",
    tool: defineTool({
      description:
        "The weather now and the forecast for the next days at a place, from Open-Meteo. Temperatures in °C, wind in km/h.",
      execute: async (args) => {
        const place = await findPlace(args.place);
        const url = new URL("https://api.open-meteo.com/v1/forecast");

        url.search = new URLSearchParams({
          current: "temperature_2m,weather_code,wind_speed_10m",
          daily:
            "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
          forecast_days: String(args.days ?? 3),
          latitude: String(place.latitude),
          longitude: String(place.longitude),
          timezone: "auto",
        }).toString();

        const forecast = await getJson(ForecastResponse, url);
        const { daily } = forecast;

        return typed(WeatherOutput, {
          days: daily.time.map((date, index) => ({
            date,
            highC: daily.temperature_2m_max[index] ?? 0,
            lowC: daily.temperature_2m_min[index] ?? 0,
            rainChancePercent:
              daily.precipitation_probability_max[index] ?? null,
            rainMm: daily.precipitation_sum[index] ?? 0,
            sky: WEATHER.get(daily.weather_code[index] ?? -1) ?? "unknown",
            windMaxKmh: daily.wind_speed_10m_max[index] ?? 0,
          })),
          now: {
            sky: WEATHER.get(forecast.current.weather_code) ?? "unknown",
            temperatureC: forecast.current.temperature_2m,
            windKmh: forecast.current.wind_speed_10m,
          },
          place: place.name,
        });
      },
      name: "weather",
      parameters: Type.Object({
        days: Type.Optional(Type.Integer({ maximum: 16, minimum: 1 })),
        place: Type.String({
          description: "A town, address or place, such as Aarhus C",
        }),
      }),
      replay: "safe",
      structuredOutputSchema: WeatherOutput,
    }),
  },
  {
    flow: true,
    phrase: "working out the travel time",
    tool: defineTool({
      description:
        "How long it takes to get from one place to another by car, bike or on foot, from OpenStreetMap routing. Without traffic, and without public transport.",
      execute: async (args) => {
        const [from, to] = await Promise.all([
          findPlace(args.from),
          findPlace(args.to),
        ]);

        const url = new URL(
          `https://routing.openstreetmap.de/${ROUTERS.get(args.mode) ?? "routed-car"}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}`
        );

        url.search = "overview=false";

        const found = await getJson(RouteResponse, url);
        const [route] = found.routes ?? [];

        if (found.code !== "Ok" || route === undefined) {
          throw new Error(
            `OpenStreetMap found no ${args.mode} route: ${found.code}.`
          );
        }

        return typed(TravelOutput, {
          from: from.name,
          kilometres: Math.round(route.distance / (METRES_PER_KM / 10)) / 10,
          minutes: Math.round(route.duration / SECONDS_PER_MINUTE),
          mode: args.mode,
          to: to.name,
        });
      },
      name: "travel_time",
      parameters: Type.Object({
        from: Type.String(),
        mode: StringEnum(["car", "bike", "foot"]),
        to: Type.String(),
      }),
      replay: "safe",
      structuredOutputSchema: TravelOutput,
    }),
  },
];
