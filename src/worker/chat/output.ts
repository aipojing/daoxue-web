export function hasAssistantOutput(content: string, reasoning: string): boolean {
  return Boolean(content || reasoning);
}
