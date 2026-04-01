# Machine Definition Refactor

> **Status:** Implemented
> **Scope:** Unified machine library, project-stored custom definitions, export dialog cleanup
> **Last updated:** 2026-04-01

---

## 1. Motivation

The current implementation treats bundled machine definitions (GRBL, Mach3, LinuxCNC) and
user-supplied custom definitions as two separate concepts with different storage and lookup
paths. This creates unnecessary complexity:

- `project.meta.machineId` — references a bundled definition by ID
- `project.meta.customMachineDefinition` — stores a single custom definition inline
- The export dialog has a special `selectedMachineId === 'custom'` code path
- Only one custom definition can exist at a time per project

The refactor unifies these into a single flat array of `MachineDefinition` objects stored in
the project. Bundled definitions are seed data loaded at project creation, not a separate
runtime concept. All machines are treated identically by the engine.

---

## 2. New Data Model

### 2.1 ProjectMeta changes

```typescript
// Remove:
machineId: string | null
customMachineDefinition: MachineDefinition | null

// Add:
machineDefinitions: MachineDefinition[]   // bundled + user-added, ordered
selectedMachineId: string | null          // id of active definition, or null if none selected
```

### 2.2 MachineDefinition — new `builtin` flag

Add a single field to `MachineDefinition` to distinguish bundled definitions from
user-added ones. This is used only by the UI to prevent deletion of built-ins.

```typescript
interface MachineDefinition {
  // ... existing fields unchanged ...
  builtin: boolean   // true for definitions seeded from the bundled library
}
```

Bundled JSON files get `"builtin": true`. User-imported definitions get `"builtin": false`.
The engine ignores this field entirely — it is UI metadata only.

### 2.3 Project creation

On `newProject()`, `machineDefinitions` is seeded with all bundled definitions:

```typescript
import { BUNDLED_DEFINITIONS } from '../engine/gcode'

meta: {
  // ...
  machineDefinitions: [...BUNDLED_DEFINITIONS],  // full copies, not references
  selectedMachineId: null,
}
```

### 2.4 Load-time migration

Existing project files without `machineDefinitions` are migrated on load:

```typescript
function migrateProject(raw: any): Project {
  if (!raw.meta.machineDefinitions) {
    raw.meta.machineDefinitions = [...BUNDLED_DEFINITIONS]

    // Carry forward any previously selected machine
    if (raw.meta.machineId) {
      raw.meta.selectedMachineId = raw.meta.machineId
    } else if (raw.meta.customMachineDefinition) {
      const custom = { ...raw.meta.customMachineDefinition, builtin: false }
      raw.meta.machineDefinitions.push(custom)
      raw.meta.selectedMachineId = custom.id
    } else {
      raw.meta.selectedMachineId = null
    }

    delete raw.meta.machineId
    delete raw.meta.customMachineDefinition
  }
  return raw
}
```

---

## 3. Machine Selection — Project Settings

Machine selection moves out of the export dialog and into **Project Settings**, alongside
units, stock, and clearance values. It is a project-level decision, not a per-export decision.

The project settings panel shows:

- A dropdown/list of all machines in `project.meta.machineDefinitions`
- An **Add machine...** button that opens a file picker for a `.json` file
- A **Remove** button for user-added (`builtin: false`) machines only
- The selected machine is persisted immediately to `project.meta.selectedMachineId`

No machine selected is a valid state. The export dialog warns and blocks download in that case.
Toolpath generation continues to work without a machine selected (see §5).

---

## 4. Export Dialog Changes

With machine selection moved to project settings, the export dialog focuses on per-export
options and output. It no longer owns machine selection.

### 4.1 Layout

```
┌─────────────────────────────────────────────────────┐
│  Export G-code                                 [✕]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Machine:   GRBL 1.1                  [Change ↗]   │
│                                                     │
│  Origin:    Using current CAM origin as X0 Y0 Z0   │
│             (edit in sketch or project tree)        │
│                                                     │
│  Units:     Millimeter                              │
│                                                     │
│  Options:                                           │
│  ☑ Emit tool change commands (M6)                   │
│  ☐ Emit coolant commands                            │
│                                                     │
│  Warnings:                                          │
│  ⚠ No machine selected — select one in settings    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Preview (first 30 lines):                          │
│  ; My Part                                          │
│  ...                                                │
│                                       [Copy all]   │
├─────────────────────────────────────────────────────┤
│  800 moves · 1,204 lines                            │
│                    [Cancel]  [Download .nc]         │
└─────────────────────────────────────────────────────┘
```

**[Change ↗]** opens project settings to the machine section. Machine selection is not
embedded inline in the dialog.

**Download** is disabled if `selectedMachineId` is null or no matching definition is found
in `machineDefinitions`.

### 4.2 Removed from dialog

- Machine picker dropdown
- "Load custom definition..." file input
- Custom definition special-casing

### 4.3 Retained in dialog

- Machine name display (read-only) + link to project settings
- Origin summary (read-only)
- Units display (read-only)
- `emitToolChanges` checkbox
- `emitCoolant` checkbox
- Warnings list (sourced from post-processor result)
- Live G-code preview with 300ms debounce
- "Copy all" button
- Stats line (move count, line count)
- Download button with correct file extension from active definition

---

## 5. Toolpath Generation Without a Machine Selected

Toolpath generation depends only on project-level clearance values (`operationClearanceZ`,
`clampClearanceZ`, `clampClearanceXY`, `maxTravelZ`), all of which remain in `ProjectMeta`.
No machine selection is required.

If `selectedMachineId` is null, toolpath generation and simulation work normally. Only
G-code export is blocked, with a clear warning in the export dialog.

---

## 6. Machine Travel Limits (Out of Scope)

Physical machine travel limits (max Z travel, XY envelope) were considered for inclusion
in `MachineDefinition`. This was deferred for the following reasons:

- Machine Z travel is expressed in machine coordinates from machine home, which the app
  has no visibility into. The relationship between machine home and work zero is unknown
  without a full machine coordinate model.
- The toolpath generator does not need absolute machine limits — it uses project-level
  clearance values which are expressed in project coordinates.
- Validating against machine limits is already listed as out of scope in the G-code export
  design.

`maxTravelZ` **remains in `ProjectMeta`** as a project-level safe travel ceiling — "how
high can I rapid in this setup" — not as a machine constant.

---

## 7. `BUNDLED_DEFINITIONS` at Runtime

`BUNDLED_DEFINITIONS` continues to exist as a module-level constant, but its role is
narrowed to:

1. Seeding `machineDefinitions` on `newProject()`
2. Load-time migration of old project files

It is not used for machine lookup at runtime. The export dialog and post-processor always
resolve the active definition from `project.meta.machineDefinitions` by `selectedMachineId`.

```typescript
// Runtime lookup — always from project array, never from BUNDLED_DEFINITIONS
function getActiveMachineDefinition(project: Project): MachineDefinition | null {
  if (!project.meta.selectedMachineId) return null
  return project.meta.machineDefinitions.find(
    d => d.id === project.meta.selectedMachineId
  ) ?? null
}
```

---

## 8. Schema Validation

`MachineDefinitionSchema` (Zod) gains the `builtin` field with a default of `false` so
that existing JSON files and user-imported definitions without the field parse correctly:

```typescript
MachineDefinitionSchema = z.object({
  // ... existing fields unchanged ...
  builtin: z.boolean().default(false),
})
```

All three bundled JSON files (`grbl.json`, `mach3.json`, `linuxcnc.json`) get
`"builtin": true` added.

---

## 9. Implementation Checklist

- `[x]` Add `builtin: boolean` to `MachineDefinitionSchema` and all bundled JSON files
- `[x]` Replace `machineId` + `customMachineDefinition` in `ProjectMeta` with
        `machineDefinitions` + `selectedMachineId`
- `[x]` Update `newProject()` to seed `machineDefinitions` from `BUNDLED_DEFINITIONS`
- `[x]` Add load-time migration for old project files
- `[x]` Add `getActiveMachineDefinition()` helper to gcode engine public surface
- `[x]` Add project store actions: `setSelectedMachineId`, `addMachineDefinition`,
        `removeMachineDefinition`
- `[x]` Move machine selection UI into Project Settings panel (list, add, remove)
- `[x]` Update export dialog — remove machine picker, show machine name + [Change ↗] link,
        disable download when no machine selected
- `[x]` Update all post-processor call sites to use `getActiveMachineDefinition()`

---

## 10. Out of Scope

- In-app editing of machine definition fields (JSON import/replace only)
- Machine travel limit / envelope validation
- Global (cross-project) machine library
- Multiple active machines per project
