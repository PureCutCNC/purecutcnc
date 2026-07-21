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
| climb / conventional milling | en avalant / en opposition | |
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

## Simplified Chinese (zh-CN)

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

### Punctuation & style

- Chinese copy uses fullwidth punctuation（，。？：）and corner quotes（“ ”）.
- Keep a space between CJK text and embedded Latin/numeric tokens ("macOS"、
  "{count} 种模式").
- `{placeholder}` tokens must be preserved exactly — the registry's
  placeholder-parity check enforces this for built-ins and the language
  editor enforces it per key for custom packs.
- Chinese has no grammatical plural: `….one`/`….other` variants share one
  string.

## Spanish (es)

Keep terms neutral across Spain and Latin America; avoid regional slang and
second-person regional forms. Use European-CNC vocabulary where it differs
(e.g. `cajera`, not literal `bolsillo`).

| English | Español | Notes |
| --- | --- | --- |
| project | proyecto | |
| sketch | croquis | CAD sense |
| feature | elemento | CAD sense; avoids overloading `operación` |
| operation | operación | CAM operation |
| toolpath | trayectoria de herramienta | full term in UI; `toolpath` only where space is tight |
| tool | herramienta | cutter, not software tool |
| stock | material en bruto | |
| machine | máquina | CNC machine in context |
| profile (operation) | perfil | |
| pocket (operation) | cajera | Common European-CNC term; avoid literal `bolsillo`. |
| edge route inside / outside | fresado de borde interior / exterior | |
| drill (operation) | taladrado | the tool bit is a `broca` |
| V-carve | V-carve | Established product/operation name (kept in English) |
| engrave | grabado | operation label; `tallado` = carve / V-carve depth |
| simulation | simulación | |
| G-code | G-code | the token "G-code"/G1/M3 etc. stays untranslated in output |
| dimension (annotation) | cota | |
| tape measure | cinta métrica | |
| snap / snapping | ajuste | CAD convention: `ajustar a…` |
| grid | cuadrícula | |
| midpoint / center | punto medio / centro | |
| intersection | intersección | |
| perpendicular (snap) | perpendicular | |
| clamp | mordaza | fixture component |
| tab | pestaña | workholding tab |
| region (mask) | máscara de región | machining filter, not a shape |
| construction geometry | geometría de construcción | never machined |
| backdrop | fondo | reference image |
| rough / finish | desbaste / acabado | machining passes |
| climb / conventional | en concordancia / en oposición | milling direction |
| feed / plunge feed | avance / avance de penetración | plunge move = `penetración` |
| stepdown / stepover | profundidad de pasada / paso lateral | |
| stock to leave | material a dejar | radial or axial as applicable |
| dwell | permanencia | drill dwell (G82) |
| offset | desfase | pattern/param and the offset tool |
| clearance | holgura | safe distance / height |
| undo / redo | deshacer / rehacer | |
| save / open / import / export | guardar / abrir / importar / exportar | |
| print | imprimir | |
| appearance | apariencia | |
| theme | tema | |
| dark / light | oscuro / claro | |
| system (follow OS) | sistema | |
| language / language pack | idioma / paquete de idioma | |
| built-in / custom | integrado / personalizado | themes and languages |
| placeholder | marcador de posición | the `{name}` tokens in catalog strings |
| unsaved changes | cambios sin guardar | |
| booklet | cuaderno de operaciones | printable operation report |

### Grammar & style

- **Register:** formal *usted* for sentences addressed to the user; bare
  infinitive/imperative for buttons and commands ("Guardar", "Añadir cota").
- **Plural:** Spanish uses the existing `.one` / `.other` variants with
  distinct strings — singular vs. plural noun ("1 región" / "2 regiones").
- **Accents & tokens:** preserve accents (á é í ó ú ñ ¿ ¡) and `{placeholder}`
  tokens exactly; machine-facing tokens (G-code words, G81/G83/M6/G0, the "mm"
  symbol, serialized enum ids) stay literal.

## German (de)

Translate into the vocabulary German-speaking machinists actually use, not
dictionary-literal renderings. Machining German freely mixes native terms
(Schruppen, Schlichten, Vorschub, Zustellung) with accepted anglicisms
(Feature, Offset, Spline) — prefer whichever a shop would write on a job
sheet. Where a term is genuinely contested, a native-speaking machinist (or
the requester) settles it; the choice below is the shipped default.

| English | Deutsch | Notes |
| --- | --- | --- |
| project | Projekt | |
| sketch | Skizze | |
| feature | Feature | CAD object; German CAD (Fusion/Inventor/Onshape) keeps "Feature". Alt: Element |
| operation | Operation | machining operation, Fusion convention; plural Operationen. Alt: Bearbeitung |
| toolpath | Werkzeugweg | also Werkzeugpfad |
| tool | Werkzeug | the cutter; a specific end mill is a Fräser |
| flat / ball end mill | Schaftfräser (flach) / Kugelfräser | |
| V-bit | V-Nutfräser | hobby shops also say "V-Bit" or "Gravierfräser" |
| drill (tool) | Bohrer | |
| stock | Rohteil | the raw blank |
| machine | Maschine | the CNC machine |
| origin (work zero) | Nullpunkt | Werkstücknullpunkt; machine X0 Y0 |
| pocket | Tasche | |
| edge route inside / outside | Kontur innen / Kontur außen | contour routing |
| V-carve | V-Gravur | kept distinct from Gravieren (engrave) |
| engrave (follow line) | Gravieren | |
| drill (operation) | Bohren | |
| surface clean | Oberfläche säubern | clears flats around raised features |
| rough / roughing | Schruppen | standard machining term |
| finish / finishing | Schlichten | standard machining term |
| 3D surface rough/finish/cleanup | 3D-Oberfläche schruppen / schlichten / nacharbeiten | |
| stepdown | Zustellung | axial depth per pass |
| stepover | Bahnabstand | |
| stepover ratio | Bahnabstand-Verhältnis | fraction of tool diameter |
| contour spacing | Konturabstand | |
| feed | Vorschub | |
| plunge / plunge feed | Eintauchen / Eintauchvorschub | |
| slot feed | Nutvorschub | fully engaged (slotting) cut |
| rapid | Eilgang | G0 |
| retract | Rückzug | |
| cut (machining) / cut depth | Schnitt / Schnitttiefe | |
| carve depth | Gravurtiefe | |
| climb / conventional | Gleichlauf / Gegenlauf | milling direction |
| cut direction | Schnittrichtung | |
| RPM / spindle speed | Drehzahl | |
| flutes | Schneiden | cutting edges |
| carbide / HSS | Hartmetall / HSS | |
| pocket pattern: offset/parallel/waterline | Offset / Parallel / Wasserlinie | |
| rest machining | Restbearbeitung | |
| tab | Haltesteg | plural Haltestege |
| clamp | Spannzwinge | workholding keep-out |
| region (mask) | Bereich (Maske) | machining filter, not a shape |
| construction geometry | Konstruktion / Konstruktionsgeometrie | never machined |
| backdrop | Hintergrundbild | reference image |
| grid | Raster | |
| snap / snapping | Fang / fangen | osnaps below |
| midpoint / center | Mittelpunkt / Zentrum | segment midpoint vs. circle center |
| intersection | Schnittpunkt | |
| perpendicular (snap) | Lot | the perpendicular foot |
| dimension (annotation) | Bemaßung | |
| tape measure | Maßband | |
| constraint | Bedingung | Autodesk calls it "Abhängigkeit" |
| fillet | Verrundung | verb: verrunden |
| chamfer | Fase | verb: anfasen |
| trim / extend | Stutzen / Dehnen | AutoCAD osnap verbs |
| offset | Offset | native alt: Versatz |
| join / boolean cut | Vereinigen / Abziehen | boolean union / difference |
| mirror / rotate / move / copy | Spiegeln / Drehen / Verschieben / Kopieren | |
| resize / scale | Größe ändern / Skalieren | |
| align / distribute | Ausrichten / Verteilen | |
| group / ungroup | Gruppieren / Gruppierung aufheben | |
| folder | Ordner | |
| undo / redo | Rückgängig / Wiederholen | |
| save / open / import / export | Speichern / Öffnen / Importieren / Exportieren | |
| print | Drucken | print scale = Maßstab |
| design (the drawing) | Design | kept — so "theme" is NOT "Design" |
| appearance | Darstellung | |
| theme | Farbschema | avoids clashing with Design |
| dark / light | Dunkel / Hell | |
| system (follow OS) | System | |
| language / language pack | Sprache / Sprachpaket | |
| built-in / custom | Integriert / Benutzerdefiniert | themes, languages, machines |
| placeholder | Platzhalter | the `{name}` tokens |
| unsaved changes | nicht gespeicherte Änderungen | |
| units; mm / inch | Einheiten; Millimeter / Zoll | symbol "mm" stays literal |
| gear terms | Zahnrad, Zähnezahl, Zahntiefe, Eingriffswinkel, Evolvente, Zahnfuß, Zahnkopf, Flanke, Bohrung | gear/tooth count/whole depth/pressure angle/involute/root/crest/flank/bore |
| coolant: flood / mist | Kühlmittel: Flutkühlung / Sprühnebel | |
| move kinds | Eilgang / Eintauchen / Anfahren / Abfahren / Schnitt | rapid/plunge/lead-in/lead-out/cut |
| booklet | Broschüre | printable operation report |

### Grammar & style

- **Register:** formal *Sie* for full sentences addressed to the user; bare
  infinitive/imperative for buttons and commands ("Speichern", "Bemaßung
  hinzufügen").
- **Capitalization:** German nouns are always capitalized, even mid-sentence
  (Breite, Höhe, Werkzeug). Only leading adjectives on two-word shape names
  stay lowercase ("abgerundetes Rechteck").
- **Plural:** unlike Chinese, German inflects. `….one` (used only for
  `count === 1`) and `….other` (everything else, including 0) take **different**
  strings — singular vs. plural noun ("{count} Modus" / "{count} Modi").
- **Umlauts / ß:** use proper ä ö ü ß. Booklet and design-print PDFs render
  them since #321 (the Unicode-font fix); do not ASCII-fold.
- **Quotation marks:** German „…" around user content, mirroring the English
  "…" pair.
- **Length:** German compounds run longer than English — keep labels tight and
  check desktop and tablet truncation (acceptance criterion).
- **`{placeholder}` tokens** are preserved exactly (registry parity test
  enforces it). Machine-facing tokens stay literal: G-code words, G81/G83/M6/G0,
  the unit symbol "mm", serialized enum ids, and tool/operation type ids.
  Deterministic number formatting happens outside the catalog and is unchanged.
