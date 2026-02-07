export const config = {
  llm: {
    baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'glm-4.7',
  },
  maxIterations: 100,
  maxConsecutiveErrors: 3,
};
