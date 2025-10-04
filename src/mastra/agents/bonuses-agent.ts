import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PgVector } from '@mastra/pg';
import { embedMany } from 'ai';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { LibSQLVector } from '@mastra/libsql';
import { prompt } from '../../prompts/prompt-1';
import { promptNew } from '../../prompts/prompt-new';

// Function to get active vector store based on environment configuration with retry logic
async function getActiveVectorStore(): Promise<PgVector> {
  const dbSource = process.env.DB_SOURCE || 'local';
  
  if (dbSource === 'supabase') {
    // Only initialize Supabase vector when needed
    const supabaseConnectionString = process.env.SUPABASE_URL || '';
    
    if (!supabaseConnectionString) {
      throw new Error('SUPABASE_URL environment variable is not set');
    }
    
    const supabaseVector = new PgVector({
      connectionString: supabaseConnectionString,
    });
    
    // Retry logic for Supabase connection
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempting Supabase connection (attempt ${attempt}/${maxRetries})...`);
        
        await supabaseVector.createIndex({
          indexName: 'mastra_vectors',
          dimension: 1536,
          metric: 'cosine',
          indexConfig: {
            type: 'hnsw',
            hnsw: {
              m: 16,
              efConstruction: 64
            }
          }
        });
        console.log('✅ Connected to Supabase');
        return supabaseVector;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        
        if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
          console.log('✅ Connected to Supabase (index exists)');
          return supabaseVector;
        }
        
        console.warn(`⚠️ Supabase connection attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`Supabase connection failed after ${maxRetries} attempts: ${lastError?.message}`);
  } else {
    // Only initialize local vector when needed
    const localConnectionString = process.env.POSTGRES_CONNECTION_STRING || '';
    
    if (!localConnectionString) {
      throw new Error('POSTGRES_CONNECTION_STRING environment variable is not set');
    }
    
    // Fix common connection string issues
    const fixedConnectionString = localConnectionString.startsWith('--postgresql://') 
      ? localConnectionString.replace('--postgresql://', 'postgresql://')
      : localConnectionString;
    
    const localVector = new PgVector({
      connectionString: fixedConnectionString,
    });
    
    // Retry logic for local connection
    const maxRetries = 3;
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempting local database connection (attempt ${attempt}/${maxRetries})...`);
        
        await localVector.createIndex({
          indexName: 'mastra_vectors',
          dimension: 1536,
          metric: 'cosine',
          indexConfig: {
            type: 'hnsw',
            hnsw: {
              m: 16,
              efConstruction: 64
            }
          }
        });
        console.log('✅ Connected to local database');
        return localVector;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        
        if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
          console.log('✅ Connected to local database (index exists)');
          return localVector;
        }
        
        console.warn(`⚠️ Local database connection attempt ${attempt} failed: ${errorMessage}`);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`Local database connection failed after ${maxRetries} attempts: ${lastError?.message}`);
  }
}

// Create a tool for querying the knowledge base with environment-based database selection
const knowledgeBaseTool = createTool({
  id: 'query_knowledge_base',
  description: 'Search the knowledge base using environment-configured database (DB_SOURCE=local|supabase)',
  inputSchema: z.object({
    query: z.string().describe('The search query to find relevant information'),
    topK: z.number().optional().default(3).describe('Number of results to return')
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      text: z.string(),
      score: z.number(),
      metadata: z.record(z.any())
    })),
    query: z.string()
  }),
  execute: async ({ context }) => {
    try {
      const { query, topK = 3 } = context;
      
      // Generate embedding for the query
      const { embeddings } = await embedMany({
        model: openai.embedding('text-embedding-3-small'),
        values: [query],
      });

      // Get active vector store with fallback
      const pgVector = await getActiveVectorStore();
      
      // Debug: Log which database source is being used
      const dbSource = process.env.DB_SOURCE || 'local';
      console.log(`🔍 Knowledge base query using: ${dbSource === 'supabase' ? 'Supabase' : 'Local PostgreSQL'} database`);
      
      // Query the vector store
      const results = await pgVector.query({
        indexName: 'mastra_vectors',
        queryVector: embeddings[0],
        topK: topK,
        includeVector: false,
      });

      console.log(`📊 Found ${results.length} results from ${dbSource === 'supabase' ? 'Supabase' : 'Local'} database`);

      return {
        results: results.map(result => ({
          text: result.metadata?.text || '',
          score: result.score,
          metadata: result.metadata || {}
        })),
        query
      };
    } catch (error) {
      console.error('Error querying knowledge base:', error);
      return {
        results: [],
        query: context.query
      };
    }
  }
});

// Create a tool for fetching affiliate data from bonuses.ca API
const affiliateApiTool = createTool({
  id: 'fetch_affiliate_data',
  description: 'Fetch affiliate links and bonus data from the bonuses API for specific casinos or top casinos when no specific names provided',
  inputSchema: z.object({
    casinoNames: z.array(z.string()).optional().describe('Array of casino names to fetch affiliate data for. If empty or not provided, will fetch top casinos'),
    limit: z.number().optional().default(20).describe('Maximum number of results to return'),
    apiUrl: z.string().optional().describe('Custom API URL to use instead of the default hardcoded URL'),
    oplistType: z.string().optional().describe('Type of oplist from metadata - affects how API data is queried'),
    fetchTopCasinos: z.boolean().optional().default(false).describe('If true, fetch top casinos regardless of casinoNames')
  }),
  outputSchema: z.object({
    affiliateData: z.array(z.object({
      casinoName: z.string(),
      imageUrl: z.string(),
      affiliateUrl: z.string().optional(),
      reviewUrl: z.string().optional(),
      ctaText: z.string().optional(),
      bonusAmount: z.string().optional(),
      bonusType: z.string().optional(),
      rank: z.number().optional(),
      isActive: z.boolean().optional(),
      priority: z.string().optional(),
      oplistType: z.string().optional()
    })),
    totalFound: z.number(),
    query: z.array(z.string())
  }),
  execute: async ({ context }) => {
    try {
      const { casinoNames = [], limit = 20, apiUrl: customApiUrl, oplistType, fetchTopCasinos = false } = context;
      
      // Use custom API URL if provided and valid, otherwise fall back to hardcoded URL
      const isValidUrl = customApiUrl && 
        customApiUrl.trim() !== '' && 
        (customApiUrl.startsWith('http://') || customApiUrl.startsWith('https://'));
      
      let apiUrl = isValidUrl 
        ? customApiUrl 
        : 'https://bonusfindercouk.gdcgroup.io/private/country-uk/rank-1';
      
      // Remove any embedded credentials from the URL (e.g., preview:1q2w3e4r@domain.com)
      // We'll use Authorization header instead
      if (apiUrl.includes('@')) {
        const urlParts = apiUrl.split('@');
        if (urlParts.length === 2) {
          const protocol = urlParts[0].split('://')[0];
          const domain = urlParts[1];
          apiUrl = `${protocol}://${domain}`;
        }
      }
      
      console.log(`🔗 Using API URL: ${apiUrl} ${isValidUrl ? '(from oplist_url)' : '(fallback to default)'}`);
      console.log(`📋 Oplist Type: ${oplistType || 'not specified'}`);
      
      // Basic auth credentials
      const username = 'preview';
      const password = '1q2w3e4r';
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      
      // Make API request with basic auth
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        }
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const apiResponse = await response.json();
      
      // Extract data from the API response structure
      const apiData = apiResponse.data || [];
      
      let filteredData;
      
      // Check if we should fetch top casinos (when no specific casino names or fetchTopCasinos is true)
      const shouldFetchTopCasinos = fetchTopCasinos || casinoNames.length === 0;
      
      if (shouldFetchTopCasinos) {
        console.log('🏆 Fetching top casinos from API (no specific casino names provided)');
        
        // Fetch top casinos by rank, regardless of casino names
        filteredData = apiData
          .flatMap((listItem: any) => listItem.opListItems || [])
          .sort((a: any, b: any) => (a.rank || 0) - (b.rank || 0)) // Sort by rank
          .slice(0, limit)
          .map((item: any) => {
            const brand = item.brand || {};
            const siteOffer = item.site_offer || {};
            const bonusAttrs = siteOffer.bonus_attributes || {};
            
            // Calculate total bonus amount
            const maxBonus1 = bonusAttrs['maximum_bonus_-_part_1'] || '';
            const maxBonus2 = bonusAttrs['maximum_bonus_-_part_2'] || '';
            const maxBonus3 = bonusAttrs['maximum_bonus_-_part_3'] || '';
            const maxBonus4 = bonusAttrs['maximum_bonus_-_part_4'] || '';
            
            const totalBonus = [maxBonus1, maxBonus2, maxBonus3, maxBonus4]
              .filter(amount => amount && !isNaN(Number(amount)))
              .reduce((sum, amount) => sum + Number(amount), 0);
            
            const bonusAmount = totalBonus > 0 ? `C$${totalBonus}` : '';
            
            // Extract free spins info
            const freeSpins = bonusAttrs['other_-_description_-_part_1'] || '';
            
            return {
              casinoName: brand.name || 'Unknown Casino',
              imageUrl: `https://media.bonusfinder.co.uk/images/${brand.brand_name_seo_friendly}.png` || '',
              affiliateUrl: item.exit_page_link_with_current_domain || '',
              reviewUrl: brand.review_link ? `https://www.bonus.ca${brand.review_link}` : '',
              ctaText: item.cta_text || 'Play now',
              bonusAmount: bonusAmount,
              bonusType: siteOffer.offer_type || 'Welcome Bonus',
              rank: item.rank || 0,
              isActive: !item.hide_cta,
              priority: 'affiliate',
              freeSpins: freeSpins,
              establishedYear: brand.established_year,
              wagering: brand.brand_attributes?.slots_wagering || '',
              withdrawalTime: brand.brand_attributes?.avg_withdrawal_time_casino || '',
              oplistType: oplistType || 'top_casinos' // Mark as top casinos data
            };
          });
      } else {
        // Different logic based on oplist_type
        if (oplistType === 'brand') {
          console.log('🏢 Using brand-specific logic for API data querying');
          
          // Brand-specific logic: query API data differently
          filteredData = apiData
            .flatMap((listItem: any) => listItem.opListItems || [])
            .filter((item: any) => {
              const casinoName = item.brand?.name || '';
              return casinoNames.some(name => 
                casinoName.toLowerCase().includes(name.toLowerCase()) ||
                name.toLowerCase().includes(casinoName.toLowerCase())
              );
            })
            .slice(0, limit)
          .map((item: any) => {
            const brand = item.brand || {};
            const siteOffer = item.site_offer || {};
            const bonusAttrs = siteOffer.bonus_attributes || {};
            
            // Brand-specific bonus calculation logic
            const maxBonus1 = bonusAttrs['maximum_bonus_-_part_1'] || '';
            const maxBonus2 = bonusAttrs['maximum_bonus_-_part_2'] || '';
            const maxBonus3 = bonusAttrs['maximum_bonus_-_part_3'] || '';
            const maxBonus4 = bonusAttrs['maximum_bonus_-_part_4'] || '';
            
            // Calculate total bonus amount with brand-specific logic
            const totalBonus = [maxBonus1, maxBonus2, maxBonus3, maxBonus4]
              .filter(amount => amount && !isNaN(Number(amount)))
              .reduce((sum, amount) => sum + Number(amount), 0);
            
            const bonusAmount = totalBonus > 0 ? `C$${totalBonus}` : '';
            
            // Brand-specific free spins extraction
            const freeSpins = bonusAttrs['other_-_description_-_part_1'] || '';
            
            return {
              casinoName: brand.name || 'Unknown Casino',
              affiliateUrl: item.exit_page_link_with_current_domain || '',
              reviewUrl: brand.review_link ? `https://www.bonus.ca${brand.review_link}` : '',
              ctaText: item.cta_text || 'Play now',
              bonusAmount: bonusAmount,
              bonusType: siteOffer.offer_type || 'Welcome Bonus',
              rank: item.rank || 0,
              isActive: !item.hide_cta,
              priority: 'affiliate',
              freeSpins: freeSpins,
              establishedYear: brand.established_year,
              wagering: brand.brand_attributes?.slots_wagering || '',
              withdrawalTime: brand.brand_attributes?.avg_withdrawal_time_casino || '',
              oplistType: 'brand' // Mark as brand-specific data
            };
          });
      } else {
        console.log('🔍 Using standard logic for API data querying');
        
        // Standard logic: query API data as usual
        filteredData = apiData
          .flatMap((listItem: any) => listItem.opListItems || [])
          .filter((item: any) => {
            const casinoName = item.brand?.name || '';
            return casinoNames.some(name => 
              casinoName.toLowerCase().includes(name.toLowerCase()) ||
              name.toLowerCase().includes(casinoName.toLowerCase())
            );
          })
          .slice(0, limit)
          .map((item: any) => {
            const brand = item.brand || {};
            const siteOffer = item.site_offer || {};
            const bonusAttrs = siteOffer.bonus_attributes || {};
            
            // Standard bonus calculation logic
            const maxBonus1 = bonusAttrs['maximum_bonus_-_part_1'] || '';
            const maxBonus2 = bonusAttrs['maximum_bonus_-_part_2'] || '';
            const maxBonus3 = bonusAttrs['maximum_bonus_-_part_3'] || '';
            const maxBonus4 = bonusAttrs['maximum_bonus_-_part_4'] || '';
            
            // Calculate total bonus amount
            const totalBonus = [maxBonus1, maxBonus2, maxBonus3, maxBonus4]
              .filter(amount => amount && !isNaN(Number(amount)))
              .reduce((sum, amount) => sum + Number(amount), 0);
            
            const bonusAmount = totalBonus > 0 ? `C$${totalBonus}` : '';
            
            // Extract free spins info
            const freeSpins = bonusAttrs['other_-_description_-_part_1'] || '';
            
            return {
              casinoName: brand.name || 'Unknown Casino',
              imageUrl: `https://media.bonusfinder.co.uk/images/${brand.brand_name_seo_friendly}.png` || '',
              affiliateUrl: item.exit_page_link_with_current_domain || '',
              reviewUrl: brand.review_link ? `https://www.bonus.ca${brand.review_link}` : '',
              ctaText: item.cta_text || 'Play now',
              bonusAmount: bonusAmount,
              bonusType: siteOffer.offer_type || 'Welcome Bonus',
              rank: item.rank || 0,
              isActive: !item.hide_cta,
              priority: 'affiliate',
              freeSpins: freeSpins,
              establishedYear: brand.established_year,
              wagering: brand.brand_attributes?.slots_wagering || '',
              withdrawalTime: brand.brand_attributes?.avg_withdrawal_time_casino || '',
              oplistType: oplistType || 'standard' // Mark the oplist type used
            };
          });
        }
      }

      return {
        affiliateData: filteredData,
        totalFound: filteredData.length,
        query: shouldFetchTopCasinos ? ['top_casinos'] : (casinoNames || [])
      };
    } catch (error) {
      console.error('Error fetching affiliate data:', error);
      return {
        affiliateData: [],
        totalFound: 0,
        query: context.casinoNames || []
      };
    }
  }
});

// Create the enhanced bonuses agent
export const bonusesAgent = new Agent({
  name: 'bonuses-agent',
  description: 'A helpful assistant that can search through knowledge documents and fetch affiliate data to provide enriched responses',
  memory: new Memory({
    storage: new LibSQLStore({ url: 'file:../../mastra.db' }),
    options: {
      threads: { generateTitle: true },
      semanticRecall: true,
      workingMemory: {
        enabled: true,
        scope: 'thread',
        template: `#User Details
Name:[]
Interests:[]
`,
      },
    },
    embedder: openai.embedding('text-embedding-3-small'),
    vector: new LibSQLVector({ connectionUrl: 'file:../../mastra.db' }),
  }),
  instructions: prompt(),
  model: openai('gpt-4o'),
  tools: {
    query_knowledge_base: knowledgeBaseTool,
    fetch_affiliate_data: affiliateApiTool
  }
});
