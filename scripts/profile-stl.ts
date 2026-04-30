import fs from 'node:fs'
import { extractStlProfileAndBounds } from '../src/import/stl.ts'

async function run() {
  const filePath = '/Users/frankp/Projects/purecutcnc/work/horse.stl'
  const buffer = fs.readFileSync(filePath)
  const base64Data = buffer.toString('base64')
  
  console.log(`Testing STL footprint extraction for ${filePath}... (${buffer.length} bytes)`)
  
  const start = Date.now()
  const result = await extractStlProfileAndBounds(base64Data, 1.0)
  const end = Date.now()
  
  if (!result) {
    console.error('Failed to extract profile.')
    return
  }
  
  console.log(`SUCCESS in ${end - start}ms!`)
  console.log(`z_bottom: ${result.z_bottom}`)
  console.log(`z_top: ${result.z_top}`)
  console.log(`Profile points: ${result.profile.segments.length}`)
}

run().catch(console.error)
