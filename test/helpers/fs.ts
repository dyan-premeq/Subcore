import { rm } from 'node:fs/promises'

/**
 * rm that tolerates Windows EBUSY/EPERM from freshly-closed sqlite handles.
 */
export async function rmTemp(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { force: true, recursive: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM') {
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
        continue
      }
      throw error
    }
  }
}
