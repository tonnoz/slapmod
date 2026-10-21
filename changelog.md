v0.2.0:
- A settings page: /slap settings has a 1 to 10 sensitivity dial over the live meter, which now draws a mark where a slap starts counting, so you can tap the desk and see what would trigger. It also sets what a slap and a double slap do, and the sound, and it works in the terminal and in the desktop app.
- A slap or a double slap can now run a slash command (like /compact) or send a prompt you wrote, as well as stop or tell Claude. By default a double slap stops Claude and sends "That's not it. Step back and try a different approach."
- Every setting can be changed from the prompt too: /slap sensitivity, /slap on, /slap double, /slap sound, and /slap status to see how it's set up.
- Command and prompt slaps need a solid slap, run at most every 5 seconds, and only go to the session you last typed in. A slap can't run /slap itself.
- The detector tells a quick double slap from one slap's ringing, and a much weaker slap felt while the bonk plays is ignored as its echo instead of every slap for 600 ms.
- Sensitivity is now a number from 1 to 10. The old low, medium and high settings go back to the default, 5.
- The voice sound is as quick as the bonk now. The lines are made once when a session starts, instead of on every slap, which waited the best part of a second for the voice to load.
- The voice has five lines instead of one per slap strength, picked at random and never the same one twice running, so thirty slaps don't all get the same "Ow!".

v0.1.0:
- First release. Slap your MacBook and it bonks, the /slap panel shows a live motion meter and your slap count, and a slap during a turn stops Claude and tells it why on your next message.
- Settings in /config for what a slap does (stop, tell, off), the sound (bonk, voice, off) and the sensitivity.
- With several Claude sessions open only one plays the sound, and when SlapMac is running slapmod stays quiet and lets SlapMac do the voices.
