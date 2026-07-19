# CNC Terminology Glossary

Reference for translators and future locales. Decide a term once here, then
use it consistently in every catalog module. User-authored names, filenames,
machine IDs, G-code tokens, and serialized enum values are never translated.

## English ↔ French

| English | Français | Notes |
| --- | --- | --- |
| project | projet | |
| sketch | esquisse | CAD convention |
| feature | entité | UI geometry; use `feature` only when referring to an internal identifier |
| operation | opération | CAM operation |
| toolpath | parcours d’outil | Standard CAD/CAM term |
| tool | outil | Use `fraise` or `foret` when the cutter type matters |
| stock | brut | CNC/machining stock |
| machine | machine | CNC machine |
| pocket | poche | |
| profile / edge route | contournage | Add `intérieur` / `extérieur` where needed |
| drill / drilling | foret / perçage | Tool / operation respectively |
| V-carve | gravure en V | |
| engrave | gravure | |
| rough / roughing | ébauche | |
| finish / finishing | finition | |
| climb / conventional milling | en avalant / conventionnel | |
| feed / plunge feed | avance / avance de plongée | |
| stepdown / stepover | profondeur de passe / recouvrement | |
| stock to leave | surépaisseur | Radiale or axiale as applicable |
| safe Z / retract height | Z de sécurité / hauteur de retrait | |
| simulation | simulation | |
| G-code | G-code | Keep program tokens such as G1/M3 unchanged |
| dimension | cote | |
| snap / snapping | accrochage | |
| grid | grille | |
| midpoint / intersection | milieu / intersection | |
| region | région | Machining filter, not a cut target |
| construction geometry | géométrie de construction | |
| tab / clamp | attache / bride | |

### French style

- Keep `{placeholder}` tokens byte-for-byte unchanged; the registry test
  enforces parity.
- Use typographic French punctuation and spacing where the UI permits it.
- Keep `CAD`, `CAM`, `CNC`, `STL`, `SVG`, `DXF`, `PDF`, `G-code`, unit
  symbols, enum values, and user-authored content unchanged.
- Prefer established workshop terms above over literal translations. French
  product documentation uses `poche`, `parcours d’outil`, `ébauche`,
  `finition`, and `en avalant`.

## English ↔ Simplified Chinese

| English | 简体中文 | Notes |
| --- | --- | --- |
| project | 项目 | |
| sketch | 草图 | |
| feature | 特征 | CAD sense |
| operation | 加工操作 | CAM operation; 操作 alone where context is clear |
| toolpath | 刀路 | industry shorthand for 刀具路径 |
| tool | 刀具 | cutter, not software tool (软件工具) |
| stock | 毛坯 | |
| machine | 机床 | the CNC machine; 机器 only for generic machinery |
| profile (operation) | 轮廓 | |
| pocket (operation) | 挖槽 | |
| drill (operation) | 钻孔 | |
| V-carve | V雕 | |
| engrave | 雕刻 | |
| simulation | 仿真 | |
| G-code | G代码 | the token "G-code"/G1/M3 etc. stays untranslated in output |
| dimension (annotation) | 标注 | 尺寸标注 in full; UI uses 标注 |
| tape measure | 卷尺测量 | |
| snap / snapping | 捕捉 | AutoCAD convention |
| grid | 网格 | |
| midpoint | 中点 | |
| center (snap) | 圆心 | circle center; generic center is 中心 |
| intersection | 交点 | |
| perpendicular (snap) | 垂足 | the perpendicular foot, AutoCAD osnap term |
| undo / redo | 撤销 / 重做 | |
| save / open / import / export | 保存 / 打开 / 导入 / 导出 | |
| print | 打印 | |
| appearance | 外观 | |
| theme | 主题 | |
| dark / light | 深色 / 浅色 | |
| system (follow OS) | 跟随系统 | |
| language | 语言 | |
| language pack | 语言包 | user-created custom language |
| built-in / custom | 内置 / 自定义 | themes and languages |
| placeholder | 占位符 | the `{name}` tokens in catalog strings |
| unsaved changes | 未保存的更改 | |

## Punctuation & style

- Chinese copy uses fullwidth punctuation（，。？：）and corner quotes（“ ”）.
- Keep a space between CJK text and embedded Latin/numeric tokens ("macOS"、
  "{count} 种模式").
- `{placeholder}` tokens must be preserved exactly — the registry's
  placeholder-parity check enforces this for built-ins and the language
  editor enforces it per key for custom packs.
- Chinese has no grammatical plural: `….one`/`….other` variants share one
  string.
