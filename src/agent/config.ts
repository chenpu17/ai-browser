export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
  },
  reasoningModel: {
    baseURL: process.env.REASONING_LLM_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.REASONING_LLM_API_KEY || process.env.LLM_API_KEY || '',
    model: process.env.REASONING_LLM_MODEL || '',
  },
  maxIterations: 20,
  maxConsecutiveErrors: 3,
};
