/** $ per million tokens: input, output, and cache reads as a share of input. */
export type Rate = { i: number; o: number; r: number; known: boolean }
export function rate(model: string, prompt: number, t: number): Rate
