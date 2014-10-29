TV Shows manager (Beta version) [download link](https://github.com/Sheraff/tvshows-alfred-workflow/raw/master/TV%20Show%20Manager.alfredworkflow "TV Shows manager.alfredworkflow")
=======================

Stream your favorite shows right from [Alfred](http://www.alfredapp.com/ "Alfred App official website"). Remember which episode you’re at (and where you stopped in it), know if a new episode is out, download for later...

Everything you want for TV Shows is in this workflow.

<img src="https://github.com/Sheraff/tvshows-alfred-workflow/blob/master/demo/demo.gif?raw=true" alt=“demo gif” />


## quick use

First and foremost, [download the workflow](https://github.com/Sheraff/tvshows-alfred-workflow/raw/master/TV%20Show%20Manager.alfredworkflow "TV Shows manager.alfredworkflow").

This workflow makes use of [NodeJS](http://nodejs.org/), if you don’t know what it is, you probably don’t have it. If you don’t like to tinker with your computer, your journey ends here :-(

This workflow also uses [VLC](http://www.videolan.org/vlc/index.html) for playback, if you don’t have it, it’s always good to get it anyway ;-)

If you have these two things, it’ll work right out of the box!


## extras

If you want better video quality, and smoothest functioning of the whole workflow, I recommend the [MPV player](http://mpv.io/):
`$ brew tap mpv-player/mpv`
`$ brew install --HEAD mpv-player/mpv/libass-ct`
`$ brew install mpv --HEAD`

If you wish to receive notifications to keep you informed of what might be happening (it’s always reassuring to know that it’s just loading and hasn’t crashed), install [terminal notifier](https://github.com/alloy/terminal-notifier):
`$ sudo gem install terminal-notifier`

## to-do list

### 1. TORRENT
 - use "season" torrents if nothing else available
 - try and use the 1x01 notation for piratebay search as backup
 - check seed nb before offering streaming (suggest DL instead) (hard to know the threshold!)

### 2. STREAMING
 - kill player before I kill peerflix
 - duration 0 case gives Infinity progress

### 3. INTERFACE
 - read user prefs from file
 - differentiate "actively following" from "rewatching an already out series" so that the homepage can display NEW EPISODE for the actively followed shows
 - better no-result case

### 4. MISC
 - handle cases where there is no internet / results from mdb or piratebay are unavailable
 - when all shows have to refresh at the same time on startup, it takes forever. Only refresh the most likely to need so (not the ended, not supposed to have a new episode out, or with which the user isn't up to date).
 - clean DB in post-processing: things we know will require re-fetching should be deleted