/** jsdom has no DataTransfer; this holds what a drag carries. */
export function dataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  const transfer = {
    types: [] as string[],
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      data.set(type, value)
      transfer.types = [...data.keys()]
    },
    getData: (type: string) => data.get(type) ?? '',
  }
  return transfer as unknown as DataTransfer
}
