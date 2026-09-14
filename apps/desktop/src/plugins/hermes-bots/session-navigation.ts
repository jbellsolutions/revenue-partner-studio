/** Serialize Bot-mode session opens without letting a failed request poison
 * the queue. The caller receives its failure so explicit thread controls can
 * display it; stale selections quietly yield to the newest navigation intent. */
export function createBotSessionNavigationQueue() {
  let tail: Promise<unknown> = Promise.resolve()

  return (open: () => Promise<unknown>, isCurrent: () => boolean): Promise<boolean> => {
    const result = tail
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) {
          return false
        }

        try {
          await open()
        } catch (error) {
          if (!isCurrent()) {
            return false
          }

          throw error
        }

        return isCurrent()
      })

    tail = result

    return result
  }
}
