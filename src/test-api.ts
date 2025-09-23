import dotenv from 'dotenv';
import { bonusesAgent } from './mastra/agents/bonuses-agent';

// Load environment variables
dotenv.config();

async function testApiIntegration() {
  console.log('🧪 Testing API Integration...\n');
  
  try {
    // Test the affiliate API tool directly
    const affiliateTool = bonusesAgent.tools.fetch_affiliate_data;
    
    console.log('📡 Testing affiliate API tool...');
    const result = await affiliateTool.execute({
      context: {
        casinoNames: ['Jackpot City', 'Casino Days'],
        limit: 5
      }
    });
    
    console.log('✅ API Response:');
    console.log(`Found ${result.totalFound} casinos`);
    console.log('Affiliate data:', JSON.stringify(result.affiliateData, null, 2));
    
  } catch (error) {
    console.error('❌ Error testing API:', error);
  }
}

// Test the full agent workflow
async function testAgentWorkflow() {
  console.log('\n🤖 Testing Agent Workflow...\n');
  
  try {
    // Test a simple query
    const response = await bonusesAgent.generate({
      messages: [
        {
          role: 'user',
          content: 'What are the best online casinos with bonuses?'
        }
      ]
    });
    
    console.log('✅ Agent Response:');
    console.log(response.text);
    
  } catch (error) {
    console.error('❌ Error testing agent:', error);
  }
}

// Run tests
async function main() {
  console.log('🚀 Starting API Integration Tests\n');
  
  await testApiIntegration();
  await testAgentWorkflow();
  
  console.log('\n✨ Tests completed!');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { testApiIntegration, testAgentWorkflow };
