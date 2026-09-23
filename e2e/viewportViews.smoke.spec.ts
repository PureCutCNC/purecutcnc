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
