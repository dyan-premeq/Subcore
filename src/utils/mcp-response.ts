export function textResponse(
  text: string,
  isError?: boolean,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}
