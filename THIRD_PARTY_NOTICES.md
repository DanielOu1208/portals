# Third-party notices

## bloub

The agents' animated avatar (`Portals/Avatar/Engine/`) is a Swift port of the avatar
engine in bloub (`src/bot/`), https://github.com/jeremy-prt/bloub, ported from commit
`b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`. The port was made for the Ryoko app and
copied here. bloub is an SVG recreation of the x.ai bot avatar. Portals and bloub are not
affiliated with, endorsed by or connected to x.ai. Portals uses its own body shapes, rest
expressions and rendering (`Portals/Avatar/AgentAvatarStyle.swift`).

```
MIT License

Copyright (c) 2026 Jérémy Perret

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

## thinking-orbs

The orb shown where a visual is about to be drawn (`Packages/PortalsKit/Sources/AgentCore/ThinkingOrb.swift`,
drawn by `Portals/Chat/ThinkingOrbView.swift`) is a Swift port of the engine of thinking-orbs 0.3.1
(`dist/engine.es.js`), https://github.com/Jakubantalik/thinking-orbs, by Jakub Antalík. The
nine states, their presets and the way each is drawn are his; the port draws them with SwiftUI's
Canvas on the app's own clock instead of a 2D canvas in a web page.

```
MIT License

Copyright (c) 2026 Jakub Antalik

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

## SwiftMath

Formulas in replies are typeset by SwiftMath 1.7.3, https://github.com/mgriebling/SwiftMath,
a Swift package the app links through `Packages/PortalsKit/Sources/MathRendering/`.
SwiftMath is a Swift translation of iosMath, https://github.com/kostub/iosMath, and
carries its licence too.

```
MIT License

Copyright (c) 2023 Computer Inspirations

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

```
The MIT License (MIT)

Copyright (c) 2013 MathChat

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

### SwiftMath's fonts

SwiftMath bundles twelve OpenType math fonts, which ship in the app with it, each
licence's text beside them (`mathFonts.bundle` in SwiftMath's resource bundle:
`GUST-FONT-LICENSE.txt` and `OFL.txt`). Portals sets formulas in Latin Modern Math
only. The copyright of each is as its font file states it.

- Under the GUST Font License, http://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt:
  - Latin Modern Math 1.959: Copyright 2012–2014 for Latin Modern Math OTF by
    B. Jackowski, P. Strzelczyk and P. Pianowski (on behalf of TeX users groups).
  - TeX Gyre Termes Math 1.543: Copyright 2012–2014 for TeX Gyre Termes Math OTF by
    B. Jackowski, P. Strzelczyk and P. Pianowski (on behalf of TeX users groups).
- Under the SIL Open Font License 1.1, https://openfontlicense.org:
  - XITS Math 1.108: Copyright (c) 2001–2011 by the STI Pub Companies; portions
    copyright (c) 1998–2003 by MicroPress, Inc., (c) 1990 by Elsevier, Inc., and
    (c) 2009–2012 by Khaled Hosny. Its licence is the STIX Font License, which is the
    Open Font License with the STIX reserved font names.
  - Asana Math 0.958: Copyright (c) 2007–2019 Apostolos Syropoulos, (c) 2000 Young Ryu,
    (c) 1997, 1999 Claudio Beccari.
  - Euler Math 0.61: Copyright (c) 1997, 2009 American Mathematical Society,
    (c) 2009, 2021 Khaled Hosny, (c) 2022–2024 Daniel Flipo.
  - Fira Math 0.3.4: Copyright (C) 2018–2020 Xiangdong Zeng.
  - Garamond-Math (2022-01-03): Copyleft (C) 2018–2022 Yuansheng Zhao and Xiangdong Zeng.
  - KpMath Light and KpMath Sans 0.63: Copyright (c) 2007–2018 Christophe Caignaert,
    (c) 2019–2024 Daniel Flipo.
  - Lete Sans Math 0.41: (c) 2024 Chenjing Bu, Daniel Flipo.
  - Libertinus Math 7.051: Copyright © 2012–2024 The Libertinus Project Authors.
  - Noto Sans Math 3.000: Copyright 2022 Google LLC.

## Sparkle

The Mac app that is a download (not the one on TestFlight) updates itself with Sparkle 2.10.1,
https://github.com/sparkle-project/Sparkle, which `scripts/release-mac.sh` adds to it.

```
Copyright (c) 2006-2013 Andy Matuschak.
Copyright (c) 2009-2013 Elgato Systems GmbH.
Copyright (c) 2011-2014 Kornel Lesiński.
Copyright (c) 2015-2017 Mayur Pawashe.
Copyright (c) 2014 C.W. Betts.
Copyright (c) 2014 Petroules Corporation.
Copyright (c) 2014 Big Nerd Ranch.
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

=================
EXTERNAL LICENSES
=================

bspatch.c and bsdiff.c, from bsdiff 4.3 <http://www.daemonology.net/bsdiff/>:

Copyright 2003-2005 Colin Percival
All rights reserved

Redistribution and use in source and binary forms, with or without
modification, are permitted providing that the following conditions 
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

--

sais.c and sais.h, from sais-lite (2010/08/07) <https://sites.google.com/site/yuta256/sais>:

The sais-lite copyright is as follows:

Copyright (c) 2008-2010 Yuta Mori All Rights Reserved.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

--

Portable C implementation of Ed25519, from https://github.com/orlp/ed25519

Copyright (c) 2015 Orson Peters <orsonpeters@gmail.com>

This software is provided 'as-is', without any express or implied warranty. In no event will the
authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial
applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the
   original software. If you use this software in a product, an acknowledgment in the product
   documentation would be appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not be misrepresented as
   being the original software.

3. This notice may not be removed or altered from any source distribution.

--

SUSignatureVerifier.m:

Copyright (c) 2011 Mark Hamlin.

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted providing that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## The coding agents' logos

The coding agents' badges (`Portals/Assets.xcassets/ClaudeLogo.imageset`,
`OpenAILogo.imageset`, `PiLogo.imageset`, `CursorLogo.imageset`, `FactoryLogo.imageset`,
`OpenCodeLogo.imageset`, `HermesLogo.imageset`) are their makers' own marks, used only to say whose agent a
sidebar entry is. Claude's and OpenAI's were downloaded on 2026-10-07, Pi's and
Cursor's on 2026-10-12, OpenCode's on 2026-11-03. Claude's and OpenAI's are
trademarks of Anthropic and OpenAI; Pi's logo is that of Earendil Inc. and Pi's
contributors, Cursor's that of Anysphere, Inc., and OpenCode's that of Anomaly.
Portals is not affiliated with or endorsed by any of them.

- Claude Code: the Claude spark, `Claude Spark - Clay.svg` from Anthropic's press kit
  (https://www.anthropic.com/press-kit, which serves
  https://www-cdn.anthropic.com/ae59ca4ca194dac9c9dc3bc78c5829468cb0e8af.zip; the file is
  `Anthropic media resources/Anthropic logos/Claude logos/3 Claude Spark/SVG/`). Bundled
  unchanged.
- Codex: OpenAI publishes no mark of Codex's own to download (its page,
  https://openai.com/codex/, heads with the Blossom; the Codex mark appears only inside
  screenshots of the app), so it wears the OpenAI Blossom from https://openai.com/brand/:
  https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg
  and, for dark mode,
  https://images.ctfassets.net/kftzwdyauwt9/3M8rPrJsENQL5tjaDzo6SL/f0f85c8e27090123c767ac3c8237b401/Blossom_Dark.svg.
  Those files also draw the mark's construction grid and a second copy of it; the
  bundled ones keep only the mark's path, unchanged, in a square viewBox centred on
  that grid.
- Pi: the Pi logo, the "Primary logo" of Pi's press kit (https://pi.dev/press-kit):
  https://pi.dev/logo.svg, the same file as the logo at the head of Pi's README
  (https://pi.dev/logo-auto.svg; https://github.com/earendil-works/pi). The press kit
  gives no terms of its own for it ("Vector logo for light/dark usage and editorial
  placements"). The site's footer says "Earendil Inc. & Contributors" and "MIT License",
  and the repository's LICENSE is the MIT licence under "Copyright (c) 2025 Mario
  Zechner", its text otherwise as printed above for bloub. The published file leaves a
  wide margin round the mark; the bundled one keeps the mark's three paths and colours,
  unchanged, in a square viewBox a sixteenth of the mark's side larger all round. The
  press kit's one-colour "Badge" (https://pi.dev/favicon.svg, "Square mark for favicons
  and compact badges") is not used.
- Cursor: the Cursor cube in 2D, from the brand assets Cursor gives for download on its
  brand guidelines page (https://cursor.com/brand, "Resources to represent Cursor
  consistently and accurately"):
  https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip,
  the files `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` and, for dark mode,
  `CUBE_2D_DARK.svg`. The page states no licence; it asks that the product be called
  Cursor, "Not Cursor AI or Cursor Code". Those files are taller than wide and give the
  cube its colour in a style block; the bundled ones keep the cube's path and colour,
  unchanged, the colour as an attribute of the path, in a square viewBox centred on the
  cube.
- Droid: the pinwheel mark of Factory, from https://factory.ai. Portals is not affiliated
  with or endorsed by Factory.

- OpenCode: the OpenCode logo, from the brand assets OpenCode gives for download on its
  brand guidelines page (https://opencode.ai/brand, "Resources and assets to help you
  work with the OpenCode brand"): https://opencode.ai/opencode-brand-assets.zip, the
  files `OpenCode Brand Assets/Logo/opencode-logo-light.svg` and, for dark mode,
  `opencode-logo-dark.svg`. The page states no licence. Those files are taller than
  wide and wrap the mark in a mask and clip path the size of the file, which draw
  nothing; the bundled ones keep the mark's two paths and colours, unchanged, in a
  square viewBox centred on the mark.

- Hermes: the Nous Girl mark of Hermes Agent by Nous Research, the files
  `assets/nous-girl-black.svg` and, for dark mode, `assets/nous-girl-white.svg` of
  https://github.com/NousResearch/hermes-agent, a repository under the MIT License, bundled
  unchanged. Portals is not affiliated with or endorsed by Nous Research.

## Codex's protocol types

The files in `bridge/src/providers/codex/types/` are generated by `codex app-server
generate-ts` from OpenAI Codex, https://github.com/openai/codex, and copied here by
`bridge/scripts/codex-types.ts`. OpenAI Codex, Copyright 2025 OpenAI, is under the Apache
License 2.0, a copy of which is in `LICENSES/Apache-2.0.txt`. They are not in the
`portals-host` npm package.

## OpenCode 2 client packages

The optional `@opencode/client@2.2.5` and its `@opencode/protocol` and
`@opencode/schema` dependencies are from OpenCode and are distributed under the MIT
License. The notice from the [pinned v2.2.5 release](https://github.com/anomalyco/opencode/blob/v2.2.5/LICENSE)
is reproduced below.
The host includes this notice in its README, which is packaged and copied into the
installed host when setup or update runs.

```
MIT License

Copyright (c) 2025 opencode

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

## Tokscale

The host's reading of the coding agents' history for its token totals
(`bridge/src/usage/readers/`) follows the counting rules of Tokscale 4.21.0
(`crates/tokscale-core/src/sessions/`: `claudecode.rs`, `codex.rs`, `pi.rs`, `droid.rs`),
https://github.com/junhoyeo/tokscale, by Junho Yeo: where each agent keeps its usage, a
Claude Code request counted once by its message and request ids and raised to its
fullest line, an advisor's iterations apart, Codex's running totals and their stale
snapshots, a Codex fork's replayed turns told apart by their UUIDv7 time, Pi's copies
counted once by response id, and reasoning kept inside the output. No code was copied:
the readers are written for the host, in TypeScript. Prices are from LiteLLM's public
list, as Tokscale's are.

```
MIT License

Copyright (c) 2025 Junho Yeo

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
