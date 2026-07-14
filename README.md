<p align="center">
  <img src="https://raw.githubusercontent.com/apmantza/pi-lens/master/banner.png" alt="pi-lens" width="1100">
</p>

# pi-lens

pi-lens gives AI coding agents fast, language-aware feedback while they write/edit.

## What It Does

- LSP diagnostics and navigation across supported languages
- Impact cascade diagnostics that show which related files were affected and run LSP diagnostics on them
- Language-specific linters, type-checkers, and scanners on every write/edit
- Safe formatting/autofix where tools are configured or confidently detected
- ast-grep and tree-sitter structural rules for correctness/security smells
- Agent-facing tools for LSP navigation/diagnostics, AST search/replace,
  diagnostics state, and project intelligence
- Review-graph intelligence for supported languages via bundled tree-sitter WASMs
- Ranked identifier search (`symbol_search`) over an always-warm word index,
  feeding the discovery funnel (symbol_search → module_report → read_symbol)
- Read-guard and edit-autopatch support to reduce bad edits
- Background security/dependency scans for opted-in projects

## Install

```bash
pi install npm:pi-lens
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-lens
```

## Documentation

- [Agent tools](docs/agent-tools.md) — pi tool names, scopes, and arguments
- [Usage guide](docs/usage.md) — lifecycle, tool behavior, MCP notes, and
  troubleshooting
- [Features](docs/features.md) — detailed feature reference
- [Word index](docs/word-index.md) — identifier search (`symbol_search`) and
  the discovery funnel
- [Tools and commands](docs/tools.md) — runtime flags and slash commands
- [Configuration](docs/globalconfig.md) — global and project config files
- [Environment variables](docs/env_variables.md) — common env vars and full
  reference link
- [Language coverage](docs/language-coverage.md) — supported languages, runners,
  and formatters
- [Dependencies](docs/dependencies.md) — auto-install policy and external tools
- [Custom rules](docs/custom-rules.md) — project ast-grep and tree-sitter rules

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow, runner,
LSP, formatter, and rule checklists, and issue/PR conventions.

Security issues should be reported privately; see [`SECURITY.md`](SECURITY.md).
pi-lens is released under the [MIT License](LICENSE).

## Contributors

Thanks goes to these wonderful people:
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
<tbody>
<tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apmantza"><img src="https://avatars.githubusercontent.com/u/247365598?v=4" width="100px;" alt=""/><br /><sub><b>Apostolos Mantzaris</b></sub></a><br /><a href="#code-apmantza" title="Code">💻</a> <a href="#doc-apmantza" title="Documentation">📖</a> <a href="#ideas-apmantza" title="Ideas & Planning">🤔</a> <a href="#maintenance-apmantza" title="Maintenance">🚧</a> <a href="#review-apmantza" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/anh-chu"><img src="https://avatars.githubusercontent.com/u/34973633?v=4" width="100px;" alt=""/><br /><sub><b>Anh Chu</b></sub></a><br /><a href="#code-anh-chu" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/loss-and-quick"><img src="https://avatars.githubusercontent.com/u/39405619?v=4" width="100px;" alt=""/><br /><sub><b>minicx</b></sub></a><br /><a href="#code-loss-and-quick" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/silvanshade"><img src="https://avatars.githubusercontent.com/u/11022302?v=4" width="100px;" alt=""/><br /><sub><b>silvanshade</b></sub></a><br /><a href="#code-silvanshade" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tifandotme"><img src="https://avatars.githubusercontent.com/u/33323177?v=4" width="100px;" alt=""/><br /><sub><b>Tifan Dwi Avianto</b></sub></a><br /><a href="#code-tifandotme" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/amit-gshe"><img src="https://avatars.githubusercontent.com/u/7383028?v=4" width="100px;" alt=""/><br /><sub><b>Amit</b></sub></a><br /><a href="#code-amit-gshe" title="Code">💻</a> <a href="#bug-amit-gshe" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fractiunate"><img src="https://avatars.githubusercontent.com/u/78024279?v=4" width="100px;" alt=""/><br /><sub><b>Fractiunate // David Rahäuser</b></sub></a><br /><a href="#code-fractiunate" title="Code">💻</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/vkarasen"><img src="https://avatars.githubusercontent.com/u/7932536?v=4" width="100px;" alt=""/><br /><sub><b>Vitali Karasenko</b></sub></a><br /><a href="#code-vkarasen" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/rfxlamia"><img src="https://avatars.githubusercontent.com/u/222023708?v=4" width="100px;" alt=""/><br /><sub><b>V</b></sub></a><br /><a href="#code-rfxlamia" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fabio-dee"><img src="https://avatars.githubusercontent.com/u/10808443?v=4" width="100px;" alt=""/><br /><sub><b>Fabio Dee</b></sub></a><br /><a href="#code-fabio-dee" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/moj02090"><img src="https://avatars.githubusercontent.com/u/57255166?v=4" width="100px;" alt=""/><br /><sub><b>moj02090</b></sub></a><br /><a href="#code-moj02090" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mehalter"><img src="https://avatars.githubusercontent.com/u/1591837?v=4" width="100px;" alt=""/><br /><sub><b>Micah Halter</b></sub></a><br /><a href="#code-mehalter" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JulienEllie"><img src="https://avatars.githubusercontent.com/u/670518?v=4" width="100px;" alt=""/><br /><sub><b>Julien Ellie</b></sub></a><br /><a href="#code-JulienEllie" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Istar-Eldritch"><img src="https://avatars.githubusercontent.com/u/3746468?v=4" width="100px;" alt=""/><br /><sub><b>Ruben Paz</b></sub></a><br /><a href="#code-Istar-Eldritch" title="Code">💻</a> <a href="#bug-Istar-Eldritch" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cjunxiang"><img src="https://avatars.githubusercontent.com/u/26619858?v=4" width="100px;" alt=""/><br /><sub><b>C.Junxiang</b></sub></a><br /><a href="#code-cjunxiang" title="Code">💻</a> <a href="#bug-cjunxiang" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/trvon"><img src="https://avatars.githubusercontent.com/u/6031322?v=4" width="100px;" alt=""/><br /><sub><b>Trevon</b></sub></a><br /><a href="#code-trvon" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/cmptr"><img src="https://avatars.githubusercontent.com/u/32746889?v=4" width="100px;" alt=""/><br /><sub><b>Aaron Bell</b></sub></a><br /><a href="#code-cmptr" title="Code">💻</a> <a href="#bug-cmptr" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/StartupBros"><img src="https://avatars.githubusercontent.com/u/16693591?v=4" width="100px;" alt=""/><br /><sub><b>Will Mitchell</b></sub></a><br /><a href="#code-StartupBros" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/spyrosbazios"><img src="https://avatars.githubusercontent.com/u/37960233?v=4" width="100px;" alt=""/><br /><sub><b>spyrosbazios</b></sub></a><br /><a href="#code-spyrosbazios" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Roman-Galeev"><img src="https://avatars.githubusercontent.com/u/40388226?v=4" width="100px;" alt=""/><br /><sub><b>Roman Galeev</b></sub></a><br /><a href="#code-Roman-Galeev" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jerryfan"><img src="https://avatars.githubusercontent.com/u/2540814?v=4" width="100px;" alt=""/><br /><sub><b>jerryfan</b></sub></a><br /><a href="#code-jerryfan" title="Code">💻</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/shaDmx"><img src="https://avatars.githubusercontent.com/u/91132641?v=4" width="100px;" alt=""/><br /><sub><b>Max L.</b></sub></a><br /><a href="#code-shaDmx" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/radge"><img src="https://avatars.githubusercontent.com/u/129205?v=4" width="100px;" alt=""/><br /><sub><b>David Ryan</b></sub></a><br /><a href="#code-radge" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JayceFreeman"><img src="https://avatars.githubusercontent.com/u/92962110?v=4" width="100px;" alt=""/><br /><sub><b>JayceFreeman</b></sub></a><br /><a href="#code-JayceFreeman" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bloodf"><img src="https://avatars.githubusercontent.com/u/1626923?v=4" width="100px;" alt=""/><br /><sub><b>Heitor Ramon Ribeiro</b></sub></a><br /><a href="#code-bloodf" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/feoh"><img src="https://avatars.githubusercontent.com/u/330070?v=4" width="100px;" alt=""/><br /><sub><b>Chris Patti</b></sub></a><br /><a href="#code-feoh" title="Code">💻</a> <a href="#bug-feoh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/chenxin-yan"><img src="https://avatars.githubusercontent.com/u/71162231?v=4" width="100px;" alt=""/><br /><sub><b>Chenxin Yan</b></sub></a><br /><a href="#code-chenxin-yan" title="Code">💻</a> <a href="#doc-chenxin-yan" title="Documentation">📖</a> <a href="#bug-chenxin-yan" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/flowing-abyss"><img src="https://avatars.githubusercontent.com/u/98622217?v=4" width="100px;" alt=""/><br /><sub><b>flowing-abyss</b></sub></a><br /><a href="#code-flowing-abyss" title="Code">💻</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/xuli500177"><img src="https://avatars.githubusercontent.com/u/62830942?v=4" width="100px;" alt=""/><br /><sub><b>Xu Yili</b></sub></a><br /><a href="#bug-xuli500177" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ricardoraposo"><img src="https://avatars.githubusercontent.com/u/50217712?v=4" width="100px;" alt=""/><br /><sub><b>Ricardo Raposo</b></sub></a><br /><a href="#code-ricardoraposo" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jsmestad"><img src="https://avatars.githubusercontent.com/u/16150?v=4" width="100px;" alt=""/><br /><sub><b>Justin Smestad</b></sub></a><br /><a href="#code-jsmestad" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/anasalsbey-glitch"><img src="https://avatars.githubusercontent.com/u/283609702?v=4" width="100px;" alt=""/><br /><sub><b>anasalsbey-glitch</b></sub></a><br /><a href="#code-anasalsbey-glitch" title="Code">💻</a> <a href="#bug-anasalsbey-glitch" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/PeraSite"><img src="https://avatars.githubusercontent.com/u/19837403?v=4" width="100px;" alt=""/><br /><sub><b>정제훈</b></sub></a><br /><a href="#code-PeraSite" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/carolitascl"><img src="https://avatars.githubusercontent.com/u/26188349?v=4" width="100px;" alt=""/><br /><sub><b>Carolina</b></sub></a><br /><a href="#bug-carolitascl" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/leakedby"><img src="https://avatars.githubusercontent.com/u/4213260?v=4" width="100px;" alt=""/><br /><sub><b>LeakedBy</b></sub></a><br /><a href="#bug-leakedby" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/mdbooth"><img src="https://avatars.githubusercontent.com/u/1318691?v=4" width="100px;" alt=""/><br /><sub><b>Matthew Booth</b></sub></a><br /><a href="#bug-mdbooth" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Wiedzmin89"><img src="https://avatars.githubusercontent.com/u/61706855?v=4" width="100px;" alt=""/><br /><sub><b>Wiedzmin89</b></sub></a><br /><a href="#ideas-Wiedzmin89" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/grodingo"><img src="https://avatars.githubusercontent.com/u/244184972?v=4" width="100px;" alt=""/><br /><sub><b>Virgile</b></sub></a><br /><a href="#bug-grodingo" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/finnvyrn"><img src="https://avatars.githubusercontent.com/u/90801772?v=4" width="100px;" alt=""/><br /><sub><b>Finn</b></sub></a><br /><a href="#ideas-finnvyrn" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ywh555hhh"><img src="https://avatars.githubusercontent.com/u/121592812?v=4" width="100px;" alt=""/><br /><sub><b>Wayne E</b></sub></a><br /><a href="#bug-ywh555hhh" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/RimuruW"><img src="https://avatars.githubusercontent.com/u/59136309?v=4" width="100px;" alt=""/><br /><sub><b>RimuruW</b></sub></a><br /><a href="#ideas-RimuruW" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Bjynt"><img src="https://avatars.githubusercontent.com/u/22177300?v=4" width="100px;" alt=""/><br /><sub><b>Bjynt</b></sub></a><br /><a href="#bug-Bjynt" title="Bug reports">🐛</a> <a href="#ideas-Bjynt" title="Ideas & Planning">🤔</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/pvtri96"><img src="https://avatars.githubusercontent.com/u/28696888?v=4" width="100px;" alt=""/><br /><sub><b>Tri Van Pham</b></sub></a><br /><a href="#bug-pvtri96" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/BingWuJ"><img src="https://avatars.githubusercontent.com/u/117666511?v=4" width="100px;" alt=""/><br /><sub><b>BingWuJ</b></sub></a><br /><a href="#bug-BingWuJ" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tackleberrybey"><img src="https://avatars.githubusercontent.com/u/156954032?v=4" width="100px;" alt=""/><br /><sub><b>tackleberrybey</b></sub></a><br /><a href="#bug-tackleberrybey" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/TaterDoge"><img src="https://avatars.githubusercontent.com/u/121467933?v=4" width="100px;" alt=""/><br /><sub><b>Mariann Abshire</b></sub></a><br /><a href="#bug-TaterDoge" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ProbabilityEngineer"><img src="https://avatars.githubusercontent.com/u/38498804?v=4" width="100px;" alt=""/><br /><sub><b>ProbabilityEngineer</b></sub></a><br /><a href="#ideas-ProbabilityEngineer" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/LeonardoRick"><img src="https://avatars.githubusercontent.com/u/17517057?v=4" width="100px;" alt=""/><br /><sub><b>Leonardo Rick</b></sub></a><br /><a href="#bug-LeonardoRick" title="Bug reports">🐛</a> <a href="#ideas-LeonardoRick" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/kenbanks-peng"><img src="https://avatars.githubusercontent.com/u/26904200?v=4" width="100px;" alt=""/><br /><sub><b>Ken Banks</b></sub></a><br /><a href="#bug-kenbanks-peng" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/rstacruz"><img src="https://avatars.githubusercontent.com/u/74385?v=4" width="100px;" alt=""/><br /><sub><b>Rico Sta. Cruz</b></sub></a><br /><a href="#ideas-rstacruz" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/acidnik"><img src="https://avatars.githubusercontent.com/u/1227955?v=4" width="100px;" alt=""/><br /><sub><b>Nikita Bilous</b></sub></a><br /><a href="#bug-acidnik" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/av1155"><img src="https://avatars.githubusercontent.com/u/117413846?v=4" width="100px;" alt=""/><br /><sub><b>Andrea Arturo Venti Fuentes</b></sub></a><br /><a href="#bug-av1155" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/dacec354"><img src="https://avatars.githubusercontent.com/u/90093629?v=4" width="100px;" alt=""/><br /><sub><b>dacec354</b></sub></a><br /><a href="#bug-dacec354" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/nodnarbnitram"><img src="https://avatars.githubusercontent.com/u/44812862?v=4" width="100px;" alt=""/><br /><sub><b>Brandon Martin</b></sub></a><br /><a href="#bug-nodnarbnitram" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/alpertarhan"><img src="https://avatars.githubusercontent.com/u/50966980?v=4" width="100px;" alt=""/><br /><sub><b>Alper Tarhan</b></sub></a><br /><a href="#bug-alpertarhan" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/asolopovas"><img src="https://avatars.githubusercontent.com/u/6893216?v=4" width="100px;" alt=""/><br /><sub><b>Andrius Solopovas</b></sub></a><br /><a href="#bug-asolopovas" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/GrahamJenkins"><img src="https://avatars.githubusercontent.com/u/6607975?v=4" width="100px;" alt=""/><br /><sub><b>Graham Jenkins</b></sub></a><br /><a href="#bug-GrahamJenkins" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/wings1848"><img src="https://avatars.githubusercontent.com/u/120104016?v=4" width="100px;" alt=""/><br /><sub><b>Wings Butterfly</b></sub></a><br /><a href="#bug-wings1848" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JohannesKlauss"><img src="https://avatars.githubusercontent.com/u/6214415?v=4" width="100px;" alt=""/><br /><sub><b>Johannes Klauss</b></sub></a><br /><a href="#ideas-JohannesKlauss" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tan-yong-sheng"><img src="https://avatars.githubusercontent.com/u/64836390?v=4" width="100px;" alt=""/><br /><sub><b>Tan Yong Sheng</b></sub></a><br /><a href="#ideas-tan-yong-sheng" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fmatray"><img src="https://avatars.githubusercontent.com/u/8267716?v=4" width="100px;" alt=""/><br /><sub><b>Frédéric</b></sub></a><br /><a href="#bug-fmatray" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/fuentesjr"><img src="https://avatars.githubusercontent.com/u/9240?v=4" width="100px;" alt=""/><br /><sub><b>Salvador Fuentes Jr</b></sub></a><br /><a href="#bug-fuentesjr" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Viterkim"><img src="https://avatars.githubusercontent.com/u/17838985?v=4" width="100px;" alt=""/><br /><sub><b>Viktor</b></sub></a><br /><a href="#bug-Viterkim" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ortonomy"><img src="https://avatars.githubusercontent.com/u/6688676?v=4" width="100px;" alt=""/><br /><sub><b>Gregory Orton</b></sub></a><br /><a href="#bug-ortonomy" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jimallen"><img src="https://avatars.githubusercontent.com/u/868773?v=4" width="100px;" alt=""/><br /><sub><b>Jim Allen</b></sub></a><br /><a href="#bug-jimallen" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/quantfiction"><img src="https://avatars.githubusercontent.com/u/49965454?v=4" width="100px;" alt=""/><br /><sub><b>quantfiction</b></sub></a><br /><a href="#bug-quantfiction" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Artawower"><img src="https://avatars.githubusercontent.com/u/16963833?v=4" width="100px;" alt=""/><br /><sub><b>Art</b></sub></a><br /><a href="#bug-Artawower" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/chozandrias76"><img src="https://avatars.githubusercontent.com/u/2087677?v=4" width="100px;" alt=""/><br /><sub><b>Colin Swenson-Healey</b></sub></a><br /><a href="#bug-chozandrias76" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/JustlyAI"><img src="https://avatars.githubusercontent.com/u/12634140?v=4" width="100px;" alt=""/><br /><sub><b>Laurent Wiesel</b></sub></a><br /><a href="#bug-JustlyAI" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/stark-bit"><img src="https://avatars.githubusercontent.com/u/44064758?v=4" width="100px;" alt=""/><br /><sub><b>Rei Starks</b></sub></a><br /><a href="#bug-stark-bit" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/robertoecf"><img src="https://avatars.githubusercontent.com/u/54923863?v=4" width="100px;" alt=""/><br /><sub><b>Roberto Freitas</b></sub></a><br /><a href="#bug-robertoecf" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/tmttodd"><img src="https://avatars.githubusercontent.com/u/160077416?v=4" width="100px;" alt=""/><br /><sub><b>tmttodd</b></sub></a><br /><a href="#bug-tmttodd" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/smaharnav"><img src="https://avatars.githubusercontent.com/u/263328627?v=4" width="100px;" alt=""/><br /><sub><b>smaharnav</b></sub></a><br /><a href="#bug-smaharnav" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/MzaGuille"><img src="https://avatars.githubusercontent.com/u/151482698?v=4" width="100px;" alt=""/><br /><sub><b>Mza.Guille</b></sub></a><br /><a href="#bug-MzaGuille" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="http://jasonrimmer.com/"><img src="https://avatars.githubusercontent.com/u/629?v=4" width="100px;" alt=""/><br /><sub><b>Jason Rimmer</b></sub></a><br /><a href="#bug-jrimmer" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ArthurHeymans"><img src="https://avatars.githubusercontent.com/u/15137817?v=4" width="100px;" alt=""/><br /><sub><b>Arthur Heymans</b></sub></a><br /><a href="#ideas-ArthurHeymans" title="Ideas & Planning">🤔</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/Blue-B"><img src="https://avatars.githubusercontent.com/u/55532956?v=4" width="100px;" alt=""/><br /><sub><b>Blue-B</b></sub></a><br /><a href="#bug-Blue-B" title="Bug reports">🐛</a></td>
    </tr><br />
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/bisko"><img src="https://avatars.githubusercontent.com/u/184938?v=4" width="100px;" alt=""/><br /><sub><b>Biser Perchinkov</b></sub></a><br /><a href="#bug-bisko" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/xificurC"><img src="https://avatars.githubusercontent.com/u/4800719?v=4" width="100px;" alt=""/><br /><sub><b>Peter Nagy</b></sub></a><br /><a href="#bug-xificurC" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/orest-tokovenko-block"><img src="https://avatars.githubusercontent.com/u/190554467?v=4" width="100px;" alt=""/><br /><sub><b>Orest Tokovenko</b></sub></a><br /><a href="#bug-orest-tokovenko-block" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://eisterman.dev/"><img src="https://avatars.githubusercontent.com/u/3028953?v=4" width="100px;" alt=""/><br /><sub><b>Federico Pasqua</b></sub></a><br /><a href="#bug-eisterman" title="Bug reports">🐛</a></td>
    </tr>
</tbody>
</table>


<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

If you land a pull request or report an issue that gets fixed, we'll add you here.
