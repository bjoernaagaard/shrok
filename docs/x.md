# X posts

With X set up, Shrok can read a post you share or name, such as a link from the X app. Reading posts through the X API costs money from your prepaid X credits, about $0.005 per post. Reading the same post again on the same UTC day is free.

Shrok uses [xurl](https://www.npmjs.com/package/@xdevplatform/xurl) and offers X only when `xurl` is installed and both of its keys are set.

1. In the [X developer portal](https://developer.x.com), create an app with OAuth 2.0 user authentication.
2. Install `xurl` where Shrok's service can find it, such as `npm install -g @xdevplatform/xurl`.
3. Give Shrok the app's client ID and secret as `XURL_CLIENT_ID` and `XURL_CLIENT_SECRET`, the same way you gave it the model key.
4. As the user Shrok runs as, register the app with xurl and log in:

   ```sh
   xurl auth apps add shrok --client-id ... --client-secret ...
   xurl auth oauth2 --app shrok
   xurl auth default shrok
   ```

   `xurl` opens a browser to sign in and keeps its tokens in `~/.xurl` of that user.

5. Restart Shrok, then share an X link with it to check.

Shrok's own sandbox can't read `~/.xurl`, so a command Shrok runs in `bash` can't take your tokens.
