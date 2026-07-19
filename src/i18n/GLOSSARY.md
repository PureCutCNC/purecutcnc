# CNC Terminology Glossary (en ↔ zh-CN ↔ es)

Reference for translators and future locales. Decide a term once here, then
use it consistently in every catalog module. User-authored names, filenames,
machine IDs, G-code tokens, and serialized enum values are never translated.

| English | 简体中文 | Español | Notes |
| --- | --- | --- | --- |
| project | 项目 | proyecto | |
| sketch | 草图 | croquis | CAD sense |
| feature | 特征 | elemento | CAD sense; avoids overloading `operación` |
| operation | 加工操作 | operación | CAM operation |
| toolpath | 刀路 | trayectoria de herramienta | Use the full term in UI; `toolpath` is acceptable shop shorthand only where space is constrained. |
| tool | 刀具 | herramienta | cutter, not software tool |
| stock | 毛坯 | material en bruto | |
| machine | 机床 | máquina | CNC machine in context |
| profile (operation) | 轮廓 | perfil | |
| pocket (operation) | 挖槽 | cajera | Common European-CNC term; avoid literal `bolsillo`. |
| drill (operation) | 钻孔 | taladrado | |
| V-carve | V雕 | V-carve | Established product/operation name |
| engrave | 雕刻 | tallar | |
| simulation | 仿真 | simulación | |
| G-code | G代码 | G-code | the token "G-code"/G1/M3 etc. stays untranslated in output |
| dimension (annotation) | 标注 | cota | |
| tape measure | 卷尺测量 | cinta métrica | |
| snap / snapping | 捕捉 | ajuste | CAD convention: `ajustar a…` |
| grid | 网格 | cuadrícula | |
| midpoint | 中点 | punto medio | |
| center (snap) | 圆心 | centro | |
| intersection | 交点 | intersección | |
| perpendicular (snap) | 垂足 | perpendicular | |
| undo / redo | 撤销 / 重做 | deshacer / rehacer | |
| save / open / import / export | 保存 / 打开 / 导入 / 导出 | guardar / abrir / importar / exportar | |
| print | 打印 | imprimir | |
| appearance | 外观 | apariencia | |
| theme | 主题 | tema | |
| dark / light | 深色 / 浅色 | oscuro / claro | |
| system (follow OS) | 跟随系统 | sistema | |
| language | 语言 | idioma | |
| language pack | 语言包 | paquete de idioma | user-created custom language |
| built-in / custom | 内置 / 自定义 | integrado / personalizado | themes and languages |
| placeholder | 占位符 | marcador de posición | the `{name}` tokens in catalog strings |
| unsaved changes | 未保存的更改 | cambios sin guardar | |
| rough / finish | — | desbaste / acabado | machining passes |
| climb / conventional | — | en concordancia / en oposición | milling direction |
| feed / plunge feed | — | avance / avance de penetración | |
| stepdown / stepover | — | profundidad de pasada / paso lateral | |
| stock to leave | — | material a dejar | radial or axial as applicable |
| clamp | — | mordaza | fixture component |
| tab | — | pestaña | workholding tab |

## Punctuation & style

- Chinese copy uses fullwidth punctuation（，。？：）and corner quotes（“ ”）.
- Keep a space between CJK text and embedded Latin/numeric tokens ("macOS"、
  "{count} 种模式").
- `{placeholder}` tokens must be preserved exactly — the registry's
  placeholder-parity check enforces this for built-ins and the language
  editor enforces it per key for custom packs.
- Chinese has no grammatical plural: `….one`/`….other` variants share one
  string.
- Spanish uses the existing `.one` / `.other` variants. Keep words neutral
  across Spain and Latin America; avoid regional slang and second-person
  regional forms.
