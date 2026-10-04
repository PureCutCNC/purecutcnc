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

import { test, expect } from './fixtures'

/**
 * View-preset dropdown smoke test (issue #243).
 *
 * Verifies the single-button dropdown that replaced the 7-button preset row
 * in both the 3D and simulation viewports: opening the menu, switching to a
 * named view, and confirming the trigger title + check-mark update.
 */
test.describe('View preset menu', () => {
  test('3D viewport: switch to Top view and verify the trigger updates', async ({ app, ui }) => {
    await ui.viewMenu.tab3d(app.page).click()

    const trigger = ui.viewMenu.trigger3d(app.page)
    await expect(trigger).toBeVisible()

    await trigger.click()
    const menu = ui.viewMenu.menu3d(app.page)
    await expect(menu).toBeVisible()

    const topOption = ui.viewMenu.option3d(app.page, 'Top view')
    await expect(topOption).toBeVisible()
    await topOption.click()

    await expect(menu).not.toBeVisible()

    await trigger.click()
    await expect(ui.viewMenu.menu3d(app.page)).toBeVisible()
    await expect(ui.viewMenu.option3d(app.page, 'Top view')).toHaveAttribute('aria-checked', 'true')
    await expect(ui.viewMenu.option3d(app.page, 'Isometric view')).toHaveAttribute('aria-checked', 'false')
  })

  test('3D viewport: Fit to model and Reset view actions are available', async ({ app, ui }) => {
    await ui.viewMenu.tab3d(app.page).click()

    const trigger = ui.viewMenu.trigger3d(app.page)
    await trigger.click()
    const menu = ui.viewMenu.menu3d(app.page)
    await expect(menu).toBeVisible()

    await expect(ui.viewMenu.action3d(app.page, 'Fit to model')).toBeVisible()
    await expect(ui.viewMenu.action3d(app.page, 'Reset view')).toBeVisible()

    await ui.viewMenu.action3d(app.page, 'Reset view').click()
    await expect(menu).not.toBeVisible()
  })

  test('simulation viewport: switch to Front view and verify the trigger updates', async ({ app, ui }) => {
    await ui.viewMenu.tabSimulation(app.page).click()

    const trigger = ui.viewMenu.triggerSim(app.page)
    await expect(trigger).toBeVisible()

    await trigger.click()
    const menu = ui.viewMenu.menuSim(app.page)
    await expect(menu).toBeVisible()

    const frontOption = ui.viewMenu.optionSim(app.page, 'Front view')
    await expect(frontOption).toBeVisible()
    await frontOption.click()

    await expect(menu).not.toBeVisible()

    await trigger.click()
    await expect(ui.viewMenu.menuSim(app.page)).toBeVisible()
    await expect(ui.viewMenu.optionSim(app.page, 'Front view')).toHaveAttribute('aria-checked', 'true')
  })
})

test('simulation GPU keeps tab tops and cut-through rims at two angles', async ({ app }) => {
  // The reported tab bridge can be only one sampled cell wide. Render that
  // heightfield through the actual surface geometry and shader in WebGL.
  await app.page.addScriptTag({ type: 'module', content: `
    import * as THREE from '/node_modules/.vite/deps/three.js';
    import { createHeightfieldTexture, createStockPlaneGeometry } from '/src/engine/simulation/gpuMesh.ts';
    import { createHeightfieldMaterial } from '/src/engine/simulation/heightfieldShader.ts';
    import { createInstancedBoundaryGroup, createWallStripTemplate } from '/src/engine/simulation/instancedBoundary.ts';

    const grid = {
      originX: 0, originY: 0, cellSize: 1, cols: 3, rows: 3,
      stockBottomZ: 0, stockTopZ: 10,
      topZ: new Float32Array([0, 0, 0, 0, 3, 0, 0, 0, 0]),
    };
    const texture = createHeightfieldTexture(grid);
    const geometry = createStockPlaneGeometry(grid);
    const material = createHeightfieldMaterial(texture, grid, new THREE.Color('#b9a83c'));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.add(new THREE.Mesh(geometry, material));
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(400, 400, false);
    const gl = renderer.getContext();
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 30);
    const sample = (x, y, z) => {
      const ndc = new THREE.Vector3(x, y, z).project(camera);
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor((ndc.x + 1) * 200), Math.floor((ndc.y + 1) * 200), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[0] + pixel[1] + pixel[2];
    };
    const results = [];
    for (const cameraZ of [6, -3]) {
      camera.position.set(1.5, 5, cameraZ);
      camera.lookAt(1.5, 1, 1.5);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      gl.finish();
      const retained = sample(1.8, 3, 1.5);
      const cleared = sample(0.5, 3, 1.5);
      grid.topZ[4] = 0;
      texture.needsUpdate = true;
      renderer.render(scene, camera);
      gl.finish();
      const cutThrough = sample(1.8, 3, 1.5);
      results.push({ retained, cleared, cutThrough });
      grid.topZ[4] = 3;
      texture.needsUpdate = true;
    }
    // A full-stock → tab-top → cut-through staircase is not a smooth slope.
    // The wall between 3 and 0 must render, or it leaves a dark slit at the tab.
    grid.topZ.set([0, 0, 0, 20, 3, 0, 0, 0, 0]);
    texture.needsUpdate = true;
    const boundary = createInstancedBoundaryGroup(texture, grid, new THREE.Color('#b9a83c'));
    // Isolate the x=2 rim; otherwise the x=1 stock-to-tab wall behind it can
    // fill the same screen pixel and mask a missing outer wall.
    const rimGeometry = createWallStripTemplate(grid, 1, 2);
    const rimPositions = rimGeometry.getAttribute('position');
    for (let vertex = 0; vertex < rimPositions.count; vertex += 1) {
      rimPositions.setX(vertex, 2);
    }
    rimPositions.needsUpdate = true;
    boundary.children[0].geometry.dispose();
    boundary.children[0].geometry = rimGeometry;
    boundary.children[1].visible = false;
    boundary.children[2].visible = false;
    scene.children[0].visible = false;
    scene.add(boundary);
    camera.position.set(5, 1.5, 1.5);
    camera.lookAt(1.5, 1.5, 1.5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    gl.finish();
    document.body.dataset.tab829Wall = String(sample(2, 1.5, 1.5));
    boundary.visible = false;
    scene.children[0].visible = true;
    camera.position.set(1.5, 6, 1.5);
    camera.lookAt(1.5, 0, 1.5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    gl.finish();
    const edgeX = sample(1.5, 3, 1.5);
    grid.topZ.set([0, 20, 0, 0, 3, 0, 0, 0, 0]);
    texture.needsUpdate = true;
    renderer.render(scene, camera);
    gl.finish();
    const edgeZ = sample(1.5, 3, 1.5);
    grid.topZ.set([0, 0, 0, 3, 3, 3, 0, 0, 0]);
    texture.needsUpdate = true;
    renderer.render(scene, camera);
    gl.finish();
    document.body.dataset.tab829TopLighting = JSON.stringify({ edgeX, edgeZ, flatTop: sample(1.5, 3, 1.5) });
    boundary.traverse((object) => {
      if (object.isMesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    renderer.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
    document.body.dataset.tab829Render = JSON.stringify(results);
  ` })
  await expect(app.page.locator('body')).toHaveAttribute('data-tab829-render', /retained/)
  const samples = await app.page.locator('body').getAttribute('data-tab829-render')
  const results = JSON.parse(samples ?? '[]') as Array<{ retained: number; cleared: number; cutThrough: number }>
  expect(results).toHaveLength(2)
  for (const result of results) {
    expect(result.retained).toBeGreaterThan(70)
    expect(result.cleared).toBeLessThan(10)
    expect(result.cutThrough).toBeLessThan(10)
  }
  const wallSample = Number(await app.page.locator('body').getAttribute('data-tab829-wall'))
  expect(wallSample).toBeGreaterThan(70)
  const topLighting = JSON.parse(await app.page.locator('body').getAttribute('data-tab829-top-lighting') ?? '{}') as {
    edgeX: number; edgeZ: number; flatTop: number
  }
  expect(Math.abs(topLighting.edgeX - topLighting.flatTop)).toBeLessThanOrEqual(2)
  expect(Math.abs(topLighting.edgeZ - topLighting.flatTop)).toBeLessThanOrEqual(2)
})

test('simulation shades a tab rim flat without flattening real slopes', async ({ app }) => {
  // Issue #829: the top-surface normal comes from neighboring cell heights, so
  // a cell beside a step used to be lit as the riser — a dark band across the
  // full width of every tab, on the top surface, at any detail. The rule lives
  // in GLSL, so only a rendered sample can catch a regression in it.
  await app.page.addScriptTag({ type: 'module', content: `
    import * as THREE from '/node_modules/.vite/deps/three.js';
    import { createHeightfieldTexture, createStockPlaneGeometry } from '/src/engine/simulation/gpuMesh.ts';
    import { createHeightfieldMaterial } from '/src/engine/simulation/heightfieldShader.ts';

    const cols = 7;
    const rows = 7;
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(400, 400, false);
    const gl = renderer.getContext();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    // Straight down, so a sample only has to name the cell it sits in.
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
    camera.up.set(0, 0, -1);
    camera.position.set(3.5, 40, 3.5);
    camera.lookAt(3.5, 0, 3.5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const render = (heights, points) => {
      const grid = {
        originX: 0, originY: 0, cellSize: 1, cols, rows,
        stockBottomZ: 0, stockTopZ: 20,
        topZ: Float32Array.from(heights),
      };
      const texture = createHeightfieldTexture(grid);
      const geometry = createStockPlaneGeometry(grid);
      const material = createHeightfieldMaterial(texture, grid, new THREE.Color('#b9a83c'));
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      renderer.render(scene, camera);
      gl.finish();
      const samples = points.map(([col, row]) => {
        const point = new THREE.Vector3(col + 0.5, grid.topZ[row * cols + col], row + 0.5).project(camera);
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.floor((point.x + 1) * 200), Math.floor((point.y + 1) * 200), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[0] + pixel[1] + pixel[2];
      });
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      return samples;
    };
    const rowsOf = (heightAt) => {
      const heights = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) heights.push(heightAt(row));
      }
      return heights;
    };

    // Kerf (cut through) → 3 mm tab → 20 mm part: the reported staircase. The
    // two cells straddling each step are flat treads; the riser between them is
    // the wall mesh's job, not the surface sheet's.
    const [partRim, partTop, tabRim, tabTop] = render(
      rowsOf((row) => (row < 2 ? 0 : row < 4 ? 3 : 20)),
      [[3, 4], [3, 5], [3, 2], [3, 3]],
    );

    // A ridge is a slope across many cells, so it must still tilt the normal —
    // otherwise the tab fix would just be "shade every top flat".
    const [ridgeTop, ridgeFlank] = render(
      rowsOf((row) => 20 - 3 * Math.abs(row - 3)),
      [[3, 3], [3, 1]],
    );

    renderer.dispose();
    document.body.dataset.tab829Shading = JSON.stringify({
      partRim, partTop, tabRim, tabTop, ridgeTop, ridgeFlank,
    });
  ` })
  await expect(app.page.locator('body')).toHaveAttribute('data-tab829-shading', /partRim/)
  const shading = JSON.parse(await app.page.locator('body').getAttribute('data-tab829-shading') ?? '{}') as {
    partRim: number; partTop: number; tabRim: number; tabTop: number; ridgeTop: number; ridgeFlank: number
  }
  // A black frame would satisfy every "matches flat" comparison below, so pin
  // that the surface actually rendered first.
  expect(shading.partTop).toBeGreaterThan(70)
  expect(shading.ridgeTop).toBeGreaterThan(70)
  // Neither side of the tab's step may borrow the riser's normal.
  expect(Math.abs(shading.partRim - shading.partTop)).toBeLessThanOrEqual(2)
  expect(Math.abs(shading.tabRim - shading.tabTop)).toBeLessThanOrEqual(2)
  // The slope shading must survive, and be visibly darker than flat stock.
  expect(shading.ridgeTop - shading.ridgeFlank).toBeGreaterThan(40)
})

test('simulation shades a shallow ball finish smoothly at any zoom', async ({ app }) => {
  // Issue #939: a ball finish on large stock samples each scallop with under
  // three cells. Its edges used to be classified as steps, so the surface
  // rendered as flat squares outlined by wall-lit risers, and moiré when zoomed
  // out. The rule and the lighting live in GLSL, so only rendered pixels can
  // catch a regression in them.
  await app.page.addScriptTag({ type: 'module', content: `
    import * as THREE from '/node_modules/.vite/deps/three.js';
    import { createHeightfieldTexture, createStockPlaneGeometry } from '/src/engine/simulation/gpuMesh.ts';
    import { createHeightfieldMaterial } from '/src/engine/simulation/heightfieldShader.ts';
    import { createInstancedBoundaryGroup } from '/src/engine/simulation/instancedBoundary.ts';

    // Parallel ball passes 2.7 cells apart (ball radius 8.5 cells, as a 1/4"
    // ball is on a 20" top at detail 1360) on a gently tilted base, so edges on
    // both axes carry a small height change.
    const cols = 240;
    const rows = 240;
    const stepover = 2.7;
    const ballRadius = 8.5;
    const heights = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row += 1) {
      const offset = ((row + 0.5) % stepover) - stepover / 2;
      const scallop = ballRadius - Math.sqrt(ballRadius * ballRadius - offset * offset);
      for (let col = 0; col < cols; col += 1) {
        heights[row * cols + col] = 20 + 0.04 * col + scallop;
      }
    }
    const grid = {
      originX: 0, originY: 0, cellSize: 1, cols, rows,
      stockBottomZ: 0, stockTopZ: 40, topZ: heights,
    };
    // Dark enough that the brightest lighting stays below the 8-bit clamp.
    const color = new THREE.Color('#c8c8c8');
    const texture = createHeightfieldTexture(grid);
    const geometry = createStockPlaneGeometry(grid);
    const material = createHeightfieldMaterial(texture, grid, color);
    const boundary = createInstancedBoundaryGroup(texture, grid, color);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.add(new THREE.Mesh(geometry, material));
    scene.add(boundary);
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(400, 400, false);
    const gl = renderer.getContext();

    // Brightness statistics over a central square of pixels, small enough to lie
    // wholly on the finished surface at that zoom.
    const measure = (halfExtent, size) => {
      const camera = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 1, 2000);
      camera.position.set(120 + 150, 21 + 260, 120 + 300);
      camera.lookAt(120, 25, 120);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      renderer.render(scene, camera);
      gl.finish();
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(200 - size / 2, 200 - size / 2, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const brightness = new Float32Array(size * size);
      for (let i = 0; i < size * size; i += 1) {
        brightness[i] = pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2];
      }
      const sorted = Float32Array.from(brightness).sort();
      const median = sorted[sorted.length >> 1];
      let maxJump = 0;
      let sum = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const value = brightness[y * size + x];
          sum += value;
          if (x > 0) maxJump = Math.max(maxJump, Math.abs(value - brightness[y * size + x - 1]));
          if (y > 0) maxJump = Math.max(maxJump, Math.abs(value - brightness[(y - 1) * size + x]));
        }
      }
      const mean = sum / (size * size);
      let variance = 0;
      for (const value of brightness) variance += (value - mean) * (value - mean);
      return {
        median,
        darkest: sorted[0] / median,
        brightest: sorted[sorted.length - 1] / median,
        maxJump: maxJump / median,
        spread: Math.sqrt(variance / (size * size)) / mean,
      };
    };

    // Close: 40 pixels per cell. Far: more than one cell per pixel.
    const close = measure(5, 160);
    const far = measure(240, 60);

    boundary.traverse((object) => {
      if (object.isMesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    geometry.dispose();
    material.dispose();
    texture.dispose();
    scene.clear();

    // Which way a slope faces: four ramps of one cell per cell, seen from
    // straight above, each sampled at its middle cell (the same height in all).
    const rampCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 500);
    rampCamera.up.set(0, 0, -1);
    rampCamera.position.set(4.5, 200, 4.5);
    rampCamera.lookAt(4.5, 0, 4.5);
    rampCamera.updateProjectionMatrix();
    rampCamera.updateMatrixWorld();
    const ramp = (slopeX, slopeZ) => {
      const rampHeights = new Float32Array(81);
      for (let row = 0; row < 9; row += 1) {
        for (let col = 0; col < 9; col += 1) {
          rampHeights[row * 9 + col] = 50 + slopeX * (col - 4) + slopeZ * (row - 4);
        }
      }
      const rampGrid = {
        originX: 0, originY: 0, cellSize: 1, cols: 9, rows: 9,
        stockBottomZ: 0, stockTopZ: 100, topZ: rampHeights,
      };
      const rampTexture = createHeightfieldTexture(rampGrid);
      const rampGeometry = createStockPlaneGeometry(rampGrid);
      const rampMaterial = createHeightfieldMaterial(rampTexture, rampGrid, color);
      const mesh = new THREE.Mesh(rampGeometry, rampMaterial);
      scene.add(mesh);
      renderer.render(scene, rampCamera);
      gl.finish();
      const pixel = new Uint8Array(4);
      gl.readPixels(200, 200, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      scene.remove(mesh);
      rampGeometry.dispose();
      rampMaterial.dispose();
      rampTexture.dispose();
      return pixel[0] + pixel[1] + pixel[2];
    };
    const facing = {
      level: ramp(0, 0),
      plusX: ramp(-1, 0),
      minusX: ramp(1, 0),
      plusZ: ramp(0, -1),
      minusZ: ramp(0, 1),
    };

    renderer.dispose();
    document.body.dataset.scallop939 = JSON.stringify({ close, far, facing });
  ` })
  await expect(app.page.locator('body')).toHaveAttribute('data-scallop939', /close/)
  const { close, far, facing } = JSON.parse(await app.page.locator('body').getAttribute('data-scallop939') ?? '{}') as {
    close: { median: number; darkest: number; brightest: number; maxJump: number; spread: number }
    far: { median: number; darkest: number; brightest: number; maxJump: number; spread: number }
    facing: { level: number; plusX: number; minusX: number; plusZ: number; minusZ: number }
  }
  // A black frame would pass every ratio below.
  expect(close.median).toBeGreaterThan(300)
  expect(far.median).toBeGreaterThan(300)
  // Close up, no riser may be lit as a wall and no slit may show the underside:
  // either one is a line far darker (or brighter) than the scallop's own shading.
  expect(close.darkest).toBeGreaterThan(0.85)
  expect(close.brightest).toBeLessThan(1.15)
  // The lighting changes continuously across cell borders: one flat shade per
  // cell jumps by 1.6 % between neighboring pixels here, interpolated 0.5 %.
  expect(close.maxJump).toBeLessThan(0.008)
  // The scallops are still there up close — the smoothing has not erased them.
  expect(close.brightest - close.darkest).toBeGreaterThan(0.03)
  // Zoomed out the scallops are narrower than a pixel and must average out
  // instead of aliasing into moiré: without the widened stencil neighboring
  // pixels differ by 3.2 % and the spread is 0.9 %, with it 0.8 % and 0.4 %.
  expect(far.maxJump).toBeLessThan(0.018)
  expect(far.spread).toBeLessThan(0.006)
  // A slope is lit by the side it faces. The key light stands at +X +Z, so a
  // face turned toward either is much brighter than one turned away; the fill
  // light stands further toward -X than -Z, which tells the two axes apart.
  expect(facing.level).toBeGreaterThan(300)
  expect(facing.plusX - facing.minusX).toBeGreaterThan(0.15 * facing.level)
  expect(facing.plusZ - facing.minusZ).toBeGreaterThan(0.15 * facing.level)
  expect(facing.minusX - facing.minusZ).toBeGreaterThan(0.015 * facing.level)
})

test('simulation draws a slanted wall straight, with tops and walls sharing its outline', async ({ app }) => {
  // Issue #939, part 2: a wall at 45° to the grid is sampled as a one-cell
  // sawtooth. Both vertex shaders move the grid corners at those jogs onto the
  // outline; only rendered pixels show whether the two meshes moved them alike.
  await app.page.addScriptTag({ type: 'module', content: `
    import * as THREE from '/node_modules/.vite/deps/three.js';
    import { createHeightfieldTexture, createStockPlaneGeometry } from '/src/engine/simulation/gpuMesh.ts';
    import { createHeightfieldMaterial } from '/src/engine/simulation/heightfieldShader.ts';
    import { createInstancedBoundaryGroup } from '/src/engine/simulation/instancedBoundary.ts';

    // 20 mm material where a cell's centre lies past the line z = x + 0.3, cut
    // through elsewhere. Drawn on cell edges the wall zigzags between
    // z - x = 0 and 1; on the outline it is the straight line z - x = 0.5.
    const cols = 24;
    const rows = 24;
    const heights = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        heights[row * cols + col] = row - col > 0.3 ? 20 : 0;
      }
    }
    const grid = {
      originX: 0, originY: 0, cellSize: 1, cols, rows,
      stockBottomZ: 0, stockTopZ: 20, topZ: heights,
    };
    const color = new THREE.Color('#c8c8c8');
    const texture = createHeightfieldTexture(grid);
    const geometry = createStockPlaneGeometry(grid);
    const material = createHeightfieldMaterial(texture, grid, color);
    const boundary = createInstancedBoundaryGroup(texture, grid, color);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.add(new THREE.Mesh(geometry, material));
    scene.add(boundary);
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(400, 400, false);
    const gl = renderer.getContext();
    const brightnessAt = (camera, x, y, z) => {
      const point = new THREE.Vector3(x, y, z).project(camera);
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor((point.x + 1) * 200), Math.floor((point.y + 1) * 200), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[0] + pixel[1] + pixel[2];
    };

    // From straight above: points 0.2 cell either side of the outline.
    const above = new THREE.OrthographicCamera(-12, 12, 12, -12, 0.1, 100);
    above.up.set(0, 0, -1);
    above.position.set(12, 60, 12);
    above.lookAt(12, 0, 12);
    above.updateProjectionMatrix();
    above.updateMatrixWorld();
    renderer.render(scene, above);
    gl.finish();
    const flatTop = brightnessAt(above, 4.5, 20, 18.5);
    let darkestInside = 1000;
    let brightestOutside = 0;
    const across = 0.2 * Math.SQRT2;
    for (let x = 3; x < 20; x += 0.37) {
      darkestInside = Math.min(darkestInside, brightnessAt(above, x - across / 2, 20, x + 0.5 + across / 2));
      brightestOutside = Math.max(brightestOutside, brightnessAt(above, x + across / 2, 20, x + 0.5 - across / 2));
    }

    // From the cut side, off the wall's normal so an X-facing and a Z-facing
    // riser would be lit differently: the wall at mid height, and the top just
    // inside its rim.
    const side = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 200);
    side.position.set(12 + 30, 15 + 14, 12 - 12);
    side.lookAt(12, 15, 12.5);
    side.updateProjectionMatrix();
    side.updateMatrixWorld();
    renderer.render(scene, side);
    gl.finish();
    let wallDarkest = 1000;
    let wallBrightest = 0;
    let rimDarkest = 1000;
    for (let x = 8; x < 16; x += 0.31) {
      const wall = brightnessAt(side, x, 10, x + 0.5);
      wallDarkest = Math.min(wallDarkest, wall);
      wallBrightest = Math.max(wallBrightest, wall);
      rimDarkest = Math.min(rimDarkest, brightnessAt(side, x - 0.1, 20, x + 0.5 + 0.1));
    }
    const sideFlatTop = brightnessAt(side, 9.5, 20, 14.5);

    // From straight below: the underside is there under material, in the
    // middle of the stock and at its border alike, and open under the cut.
    const below = new THREE.OrthographicCamera(-12, 12, 12, -12, 0.1, 100);
    below.up.set(0, 0, -1);
    below.position.set(12, -60, 12);
    below.lookAt(12, 0, 12);
    below.updateProjectionMatrix();
    below.updateMatrixWorld();
    scene.children[0].visible = false;
    renderer.render(scene, below);
    gl.finish();
    const underside = {
      middle: brightnessAt(below, 4.5, 0, 18.5),
      westBorder: brightnessAt(below, 0.5, 0, 20.5),
      southBorder: brightnessAt(below, 2.5, 0, 23.5),
      underCut: brightnessAt(below, 18.5, 0, 4.5),
    };

    boundary.traverse((object) => {
      if (object.isMesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    renderer.dispose();
    geometry.dispose();
    material.dispose();
    texture.dispose();
    document.body.dataset.outline939 = JSON.stringify({
      flatTop, darkestInside, brightestOutside, wallDarkest, wallBrightest, rimDarkest, sideFlatTop, underside,
    });
  ` })
  await expect(app.page.locator('body')).toHaveAttribute('data-outline939', /flatTop/)
  const outline = JSON.parse(await app.page.locator('body').getAttribute('data-outline939') ?? '{}') as {
    flatTop: number; darkestInside: number; brightestOutside: number
    wallDarkest: number; wallBrightest: number; rimDarkest: number; sideFlatTop: number
    underside: { middle: number; westBorder: number; southBorder: number; underCut: number }
  }
  expect(outline.flatTop).toBeGreaterThan(300)
  expect(outline.sideFlatTop).toBeGreaterThan(300)
  // The top surface ends on the straight outline: flat top everywhere just
  // inside it, nothing just outside. On cell edges a sawtooth tooth or notch
  // crosses one of the two rows of points.
  expect(outline.darkestInside).toBeGreaterThan(0.97 * outline.flatTop)
  expect(outline.brightestOutside).toBeLessThan(10)
  // The wall is one flat face: lit alike along its whole length. A sawtooth
  // alternates two faces at right angles.
  expect(outline.wallDarkest).toBeGreaterThan(70)
  expect(outline.wallBrightest - outline.wallDarkest).toBeLessThanOrEqual(0.03 * outline.wallBrightest)
  // And the top meets it: just inside the rim is flat top, not a notch that
  // shows the wall behind it.
  expect(outline.rimDarkest).toBeGreaterThan(0.97 * outline.sideFlatTop)
  // The underside still covers every cell that has material, out to the
  // stock's border, and nothing else.
  expect(outline.underside.middle).toBeGreaterThan(70)
  expect(outline.underside.westBorder).toBe(outline.underside.middle)
  expect(outline.underside.southBorder).toBe(outline.underside.middle)
  expect(outline.underside.underCut).toBeLessThan(10)
})

