# Connect an agent to Slack

Open the agent's **Slack** tab to see its app status. New agents reach the same component at **Connect channels**, after name, job, release and activation. Connecting Slack is optional.

1. Turn on the agent and choose **Create and install Slack app**. A workspace administrator must configure app creation first.
2. Install the app on Slack's consent screen. The callback completes installation and returns to the Slack tab. If consent is declined or the link expires, start a new installation from that tab. Used links are never retried automatically.
3. Open **Channels**, search by name prefix and choose **Connect**. The default response switch applies to channels added from the current screen only.
4. Turn a connected channel's switch on to respond to mentions, or off to stop responding there. Failed saves show an error and retain the stored setting. Choose **Set home** to change the home channel.

The server joins public channels automatically. Invite the bot to private channels with `/invite`. Search includes public channels and private channels the bot has joined. **Load more** reads the next page. The screen warns when Slack rate limits leave old results or the list is truncated.

**Disconnect** revokes the agent's Slack identity and channel bindings. **Delete app** deletes the Slack app and stored credentials. Both actions explain their consequences before confirmation.

Use arrow keys on tabs, Tab to reach switches, and Space to change a response. Results and errors are announced to assistive technology.

If event registration is unfinished, the callback shows a verification notice. The current read API provides no event registration status, verification timestamp or public event URL, so later visits do not infer those values. Actual Slack mentions and event handling after revocation require separate human verification.
