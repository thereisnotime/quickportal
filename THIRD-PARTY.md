# Third-party code

QuickPortal vendors one dependency. It is committed here rather than fetched at
runtime so the page loads no third-party origin, works on an airgapped cluster,
and stays inside a `script-src 'self'` Content-Security-Policy.

## js-yaml

- Upstream: https://github.com/nodeca/js-yaml
- Version: 4.1.0
- Licence: MIT
- Vendored file: `src/assets/js-yaml.mjs` (the unminified ESM build, `dist/js-yaml.mjs`)
- SHA-256: `16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91`

Unminified on purpose: this is the one piece of code here that nobody in this
project wrote, so a reviewer should be able to read it.

To update, replace the file from the published package, update the version and
hash above, and confirm it still contains no `eval`, `new Function` or
`document.write`, since any of those would require loosening the CSP.

### Upstream licence

    (The MIT License)
    
    Copyright (C) 2011-2015 by Vitaly Puzrin
    
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    
    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.
