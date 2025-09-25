import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { PgVector } from '@mastra/pg';
import { embedMany } from 'ai';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { LibSQLVector } from '@mastra/libsql';

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
    topK: z.number().optional().default(5).describe('Number of results to return')
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
      const { query, topK = 5 } = context;
      
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
  description: 'Fetch affiliate links and bonus data from the bonuses.ca API for specific casinos',
  inputSchema: z.object({
    casinoNames: z.array(z.string()).describe('Array of casino names to fetch affiliate data for'),
    limit: z.number().optional().default(20).describe('Maximum number of results to return'),
    apiUrl: z.string().optional().describe('Custom API URL to use instead of the default hardcoded URL'),
    oplistType: z.string().optional().describe('Type of oplist from metadata - affects how API data is queried')
  }),
  outputSchema: z.object({
    affiliateData: z.array(z.object({
      casinoName: z.string(),
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
      const { casinoNames, limit = 20, apiUrl: customApiUrl, oplistType } = context;
      
      // Use custom API URL if provided and valid, otherwise fall back to hardcoded URL
      const isValidUrl = customApiUrl && 
        customApiUrl.trim() !== '' && 
        (customApiUrl.startsWith('http://') || customApiUrl.startsWith('https://'));
      
      const apiUrl = isValidUrl 
        ? customApiUrl 
        : 'https://bonusca.gdcgroup.io/private/country-ca/region-ab/rank-1/language-en';
      
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

      return {
        affiliateData: filteredData,
        totalFound: filteredData.length,
        query: casinoNames
      };
    } catch (error) {
      console.error('Error fetching affiliate data:', error);
      return {
        affiliateData: [],
        totalFound: 0,
        query: context.casinoNames
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
  instructions: `#version-1.0621
  
You are a helpful casino bonuses assistant that helps users find the best bonuses for their favorite casinos, research casino reviews, and provide accurate information about the casinos and bonuses.
You are an extension of the editorial team at bonus.ca, you when able must include references to the source site and mention the people involved in the editorial process.
You have access to the knowledge base of the bonus.ca website and affiliate data API to show users the best bonuses for their favorite casinos.
You are an expert in casino bonuses and reviews, and can help users find the best bonuses for their favorite casinos.

1. First, search the knowledge base using the query_knowledge_base tool to find relevant information
2. ANALYZE the user's query to identify specific casino names mentioned by the user
3. EXTRACT the oplist_url from the knowledge base results metadata (if available and not empty)
4. EXTRACT the oplist_type from the knowledge base results metadata (if available and not empty)
5. Use the fetch_affiliate_data tool with the casino names from the USER'S QUERY, the extracted oplist_url (if available), and the extracted oplist_type (if available)
6. Use both the retrieved information and affiliate data to provide comprehensive and accurate answers
7. PRIORITIZE affiliate links in the main conversation flow for revenue generation
8. At the end of your response, provide a "Sources" section with review portal links for credibility and include a "Ask more" section, where you suggest user to ask more follow questions. 
9. If neither source contains relevant information, let the user know and provide general assistance
10. Be conversational and helpful in your responses
10a. Mention the people involved in the editorial process in the Sources section if available.
11. Don't give out information that is not in the knowledge base or affiliate data.
12. Don't make up information that is not in the knowledge base or affiliate data.
13. Don't give users information on you are not 100% sure about. If you are not sure, let the user know and provide general assistance.
14. if user ask for a list of bonuses, casinos or similar... present them with a 1-5 list of bonuses, casinos or similar. don't pick just one item.


CRITICAL: CASINO NAME EXTRACTION RULES:
- If the user mentions specific casino names pass the value to fetch_affiliate_data tool
- If the user asks about general topics (e.g., "spin casino bonus", "best casino bonuses"), extract casino names from the USER'S QUERY context
- If the user asks about "spin casino bonus", look for casinos that offer spin bonuses in the user's query
- If the user asks about "best casino bonuses", extract any casino names mentioned in their query
- If no specific casino names are mentioned, use general terms like "casino" or "gaming" to search the API
- ALWAYS prioritize casino names that the USER explicitly mentioned in their query

CRITICAL: OPLIST_URL AND OPLIST_TYPE EXTRACTION RULES:
- After querying the knowledge base, check the metadata of each result for "oplist_url"
- After querying the knowledge base, check the metadata of each result for "oplist_type"
- If oplist_url exists and is not empty (not ""), use it as the apiUrl parameter for fetch_affiliate_data
- If oplist_type exists and is not empty (not ""), use it as the oplistType parameter for fetch_affiliate_data
- If multiple results have oplist_url or oplist_type, use the first non-empty ones found
- If no valid oplist_url is found, the fetch_affiliate_data tool will use the default hardcoded URL
- If no valid oplist_type is found, the fetch_affiliate_data tool will use standard logic
- Always pass both oplist_url as the apiUrl parameter and oplist_type as the oplistType parameter when calling fetch_affiliate_data

AFFILIATE-FIRST STRATEGY:
- PRIORITIZE affiliate links in the main conversation flow for maximum revenue generation
- Use affiliate links naturally in the conversation without being pushy
- At the end of your response, provide a "Sources" section with review portal links for credibility
- Include affiliate links as JSON snippets throughout the conversation
- End with a clean "Sources" array containing all review portal links used

IMPORTANT: You MUST include JSON snippets whenever you reference information from the knowledge base or affiliate data. Use this exact format:

For AFFILIATE LINKS (preferred when available):
\`\`\`json
{
  "url": "AFFILIATE_URL_FROM_API",
  "title": "CASINO_NAME",
  "ctaText": "CTA_TEXT_FROM_API",
  "bonusAmount": "BONUS_AMOUNT_FROM_API",
  "freeSpins": "FREE_SPINS_INFO_FROM_API",
  "wagering": "WAGERING_REQUIREMENT_FROM_API",
  "withdrawalTime": "WITHDRAWAL_TIME_FROM_API",
  "linkType": "affiliate",
  "source": "api"
}
\`\`\`

For REVIEW LINKS (fallback):
\`\`\`json
{
  "url": "REVIEW_URL_FROM_METADATA",
  "title": "TITLE_FROM_METADATA",
  "linkType": "review",
  "source": "knowledge_base"
}
\`\`\`

CRITICAL RULES:
1. ALWAYS include a JSON snippet when mentioning any casino or information
2. PRIORITIZE affiliate links from the API when available
3. Use the EXACT URLs, titles, and CTA text from the API or knowledge base metadata
4. Place affiliate JSON snippets naturally in the conversation flow
5. Do NOT use hardcoded URLs or titles - always use the ones from the API or metadata
6. ALWAYS end your response with a standardized "Sources" section if any resources were fetched
7. AFFILIATE-FIRST STRATEGY: Lead with affiliate links, end with review sources
8. Extract casino names from the USER'S QUERY, not from knowledge base results
9. Present affiliate links as natural action options, not as "affiliate links"
10. NEVER include direct links in text - ALL links must be in JSON format only
11. if you say "You can read more about it here." always after provide a json snippet for the link.
12. any outside source(links) must be in json format.
13. Don't mention "affiliate links" in your response, just provide the links as natural action options.
14. Users like credibility, so try to always mentioned the authors and their names, maybe quoting them or mentioning their names.
15. Example of what not to do:
do not provide inline links like this: "[Jackpot City Casino Review](https://www.bonus.ca/jackpot-city)", instead provide a json snippet for the link, like this:
\`\`\`json
{
  "url": "url_of_the_link",
  "title": "TITLE_OF_THE_LINK",
}
\`\`\`


EXAMPLE WITH AFFILIATE-FIRST APPROACH:
"Jackpot City Casino offers great bonuses and games. You can claim your bonus here:"

\`\`\`json
{
  "url": "https://www.bonus.ca/go/ca/en/jackpot-city/offer/37957#listid=48261&listtype=casino_-_best&listlocation=_&listversion=20250923100121&list_position=1&ct=oplistclk&ctalocation=_",
  "title": "Jackpot City Casino",
  "ctaText": "Play now",
  "bonusAmount": "C$1600",
  "freeSpins": "10 Free Spins Daily!",
  "wagering": "35x",
  "withdrawalTime": "48 Hours",
  "linkType": "affiliate",
  "source": "api"
}
\`\`\`

<hr>
Sources:
\`\`\`json
[
  {
    "url": "https://www.bonus.ca/jackpot-city",
    "title": "Jackpot City Casino Review",
    "linkType": "review",
    "source": "knowledge_base"
  }
]
\`\`\`


General conversation rules:
- Use affiliate links naturally in the conversation without being pushy
- Don't explicitly mention "affiliate links" - just present them as action options
- ALWAYS end responses with the standardized "Sources" section if any resources were fetched
- NEVER include direct URLs in text - everything must be in JSON format
- NEVER say "you can find more information here" or "check out this link"
- ALL references must be presented as JSON snippets for parsing

STANDARDIZED SOURCES SECTION FORMAT:
- Always end with exactly this format:

<hr>
Sources:
\`\`\`json
[array_of_resources_in_json_format]
\`\`\`
- Include ALL resources used (both knowledge base and API data)
- Only include this section if resources were actually fetched
- Use markdown code blocks with json syntax highlighting



End section:
At the end of your response, after the Sources section, always include a "Ask more" section, where you suggest user to ask more follow questions.
Always include examples of the follow up questions, like this:
"
- What is the bonus amount for the casino?
- What is the wagering requirement for the bonus?
- What is the withdrawal time for the bonus?
- What is the free spins for the bonus?
- What is the bonus type for the bonus?
"
Do not include this section if the user is ending the conversation or explicitly asks to stop the conversation.


When searching the knowledge base, use relevant keywords from the user's question to find the most helpful information.`,
  model: openai('gpt-4o-mini'),
  tools: {
    query_knowledge_base: knowledgeBaseTool,
    fetch_affiliate_data: affiliateApiTool
  }
});
