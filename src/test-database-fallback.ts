import { bonusesAgent } from './mastra/agents/bonuses-agent.js';

async function testDatabaseFallback() {
  console.log('🧪 Testing Database Fallback System...\n');

  try {
    // Test knowledge base query (with automatic fallback)
    console.log('1. Testing knowledge base query...');
    const queryResult = await bonusesAgent.execute({
      messages: [{ role: 'user', content: 'What are the best online casinos?' }]
    });
    
    console.log('Query Result:', queryResult);
    console.log('');

    // Test affiliate data fetch
    console.log('2. Testing affiliate data fetch...');
    const affiliateResult = await bonusesAgent.execute({
      messages: [{ role: 'user', content: 'Show me Jackpot City Casino bonuses' }]
    });
    
    console.log('Affiliate Result:', affiliateResult);

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testDatabaseFallback();
