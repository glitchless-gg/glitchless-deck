# Notice

glitchless-deck is a Node port of [Deck Delivery](https://github.com/banjtheman/macos-to-steam-deck) (`deck.py`, MIT, Copyright (c) 2026 Banjo Obayomi), extended for every host OS and engine and for Glitchless measurements.

Like Deck Delivery, it speaks the protocol of the SteamOS devkit, which it learned from Valve's open-source client, [steamos-devkit](https://gitlab.steamos.cloud/devkit/steamos-devkit). The pairing request (the key followed by the client's marker phrase, posted to port 32000), the Bonjour service it looks for (`_steamos-devkit._tcp`), and the requests written to Steam's devkit pipe (`create-shortcut`, `list-shortcuts`, `delete-shortcut` and `run-game`, as `steam-client-create-shortcut`, `devkit_utils/resolve.py` and `steam-devkit-rpc` send them) follow that client. Its license:

```text
MIT License

Copyright (c) 2017-2022 Valve Software inc., Collabora Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

glitchless-deck is not made or endorsed by Valve. Steam, Steam Deck and SteamOS are trademarks of Valve Corporation.
