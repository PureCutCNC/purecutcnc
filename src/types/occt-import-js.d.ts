/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The part of `occt-import-js` (Open CASCADE compiled to WASM, LGPL-2.1) that
 * the STEP importer uses (issue #784). The package ships no types.
 *
 * Result arrays are plain JavaScript arrays built by the Emscripten binding, not
 * typed arrays.
 */
declare module 'occt-import-js' {
  export interface OcctImportParams {
    /** Unit of the output numbers; OCCT converts from the file's declared unit. Default `millimeter`. */
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'
    /** Default `bounding_box_ratio`. */
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value'
    linearDeflection?: number
    /** Radians. Default 0.5. */
    angularDeflection?: number
  }

  export interface OcctMesh {
    name: string
    attributes: {
      position: { array: number[] }
      normal?: { array: number[] }
    }
    index: { array: number[] }
  }

  export interface OcctImportResult {
    success: boolean
    meshes?: OcctMesh[]
  }

  export interface OcctImportModule {
    ReadStepFile(content: Uint8Array, params: OcctImportParams | null): OcctImportResult
  }

  export interface OcctModuleOverrides {
    /** Pre-fetched `.wasm` bytes, so the glue never resolves the file relative to its own script. */
    wasmBinary?: ArrayBuffer
    /** OCCT writes its read diagnostics here, not to the result. */
    print?: (text: string) => void
    printErr?: (text: string) => void
  }

  export default function occtimportjs(overrides?: OcctModuleOverrides): Promise<OcctImportModule>
}
