---
title: How to change your slack picture with dynamic information
---

If you want to change your slack profile picture automatically, this is the easiest way I found so far.

```
curl https://<your team slack host>/api/users.setPhoto \
    -F "token=<your user token>" \
    -F "image=@/Users/lincai/desktop128.png"
```

You can get your token from [this page.](https://api.slack.com/custom-integrations/legacy-tokens). And the image path has to be absolute path.

Then, all you have to do left is to put this curl into a cron job or some program running in background. I worte a little python to produce a png showing our system status. So when people are looking at me, they know how happy our system is.
