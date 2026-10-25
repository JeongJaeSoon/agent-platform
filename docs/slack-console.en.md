# Connect an agent to Slack

Open the agent's **Slack** tab to see its app status. New agents reach the same component at **Connect channels**, after name, job, release and activation. Connecting Slack is optional.

Once the app is installed, the Slack tab is one page. A status row at the top shows the connection, bot ID, home channel and whether DMs are received, followed by **Channels**, **Basic**, **Advanced** and **Danger zone**. Choose a section in the list on the left to jump to it. On narrow screens the list folds into one button above the content that names the section you are in; pick a section from it and the list folds again.

1. Turn on the agent and choose **Create and install Slack app**. A workspace administrator must configure app creation first.
2. Install the app on Slack's consent screen. The callback completes installation, returns to the Slack tab and shows the result in a notice at the bottom of the screen. If consent is declined or the link expires, a notice says so; start a new installation from that tab. Used links are never retried automatically. When permissions or event settings change, choose **Reinstall** in the app card under **Advanced**. In the same card, the app ID row has **Copy** for the app ID and **Open in Slack**, which opens the app's Slack settings page in a new tab.
3. In the **Channels** section choose **Add channel**, search by name prefix and choose **Connect**. A notice at the bottom of the screen shows the result. The **Default response for new channels** switch in **Basic** is saved to the server as soon as you change it and applies to channels connected after that. Channels already connected do not change. It starts off. **Receive DMs** saves the DM binding separately.
4. Turn a connected channel's switch on to respond to mentions, or off to stop responding there. Failed saves show an error and retain the stored setting. Choose **Set home** to change the home channel.

Invite the bot to both public and private channels with `/invite`. The current server does not join a channel when its binding is saved. A channel without the bot carries a **/invite required** tag and a copy button, which copies `/invite @<agent slug>` to the clipboard. If the browser blocks the clipboard, a field with the command selected appears so you can copy it yourself. Search includes public channels and private channels the bot has joined. **Load more** reads the next page. The screen warns when Slack rate limits leave old results or the list is truncated.

In the **Danger zone**, **Disconnect** on the **Disconnect Slack** row revokes the agent's Slack identity and channel bindings; the Slack app stays and can be installed again. **Delete app** on the **Delete the Slack app** row deletes the Slack app and stored credentials. This can't be undone, and connecting again makes a new app. Both actions explain their consequences before confirmation.

Press Enter on a section link to move focus to that section, Tab to reach switches, and Space to change a response. Results and errors are announced to assistive technology.

If event registration is unfinished, the callback shows a verification notice. The current read API provides no event registration status, verification timestamp or public event URL, so later visits do not infer those values. Actual Slack mentions and event handling after revocation require separate human verification.
