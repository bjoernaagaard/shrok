export const explain = (name: string): string => {
  if (name === "gmail_send") {
    return "Sending is blocked: the Gmail adapter cannot bind the acting account and final message to a delivered approval attachment. Save a draft for the owner to send manually.";
  }

  return "This operation has no reviewed capability and is blocked. A model judgment or generic approval cannot authorize it. The owner must complete it manually. Do not try another tool to bypass this restriction.";
};
