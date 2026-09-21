# 余白 — mobile reader

Static, offline-capable reader for books you prepare in the PC edition.
No books, notes, audio, server code, model files, passwords, or OAuth secrets are included.

## Hosting
Enable GitHub Pages: Deploy from a branch, main, /(root). HTTPS is required.
Use the same Google OAuth web-client ID and Cloud project as the PC edition.
Authorize the HTTPS origin (without the repository path) and http://127.0.0.1:18743.
The only Google scope requested is drive.appdata. Files stay private in the appDataFolder.
The client ID is public configuration; do not commit a client secret or an access token.

## Use
Add this site to your home screen first, then open that installed app.
Connect to Google, select a book, and wait for all pages to finish downloading.
Keep the app visible during transfer. An interrupted transfer can resume.
Confirm reading and audio with airplane mode before going out.
Notes sync while online with valid Google authorization, not while the app is closed.
Text corrections sync as reviewable notes; PC confirms them and regenerates audio.
Voice-pronunciation corrections can be written as notes and applied to the PC dictionary.
Publishing an updated book does not automatically replace device data: download the update.

## Storage and privacy
A downloaded book uses device storage as well as Drive storage. Audio may be large.
Drive's application-data folder is not shown in My Drive. Manage books in this app.
This first release retains previous book versions and interrupted transfer data for recovery.
Repeated changes may increase storage usage. No automatic cloud deletion is performed.
Browser storage can be cleared by the user or OS. Sync notes before clearing anything.
Google access tokens are kept in memory only. Reconnect after expiry or relaunch.
Real iPhone/Android background and lock-screen playback still require device verification.
