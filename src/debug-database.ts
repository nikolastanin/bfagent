import { PgVector } from '@mastra/pg';
import { embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Client } from 'pg';

// Test both database connections
const supabaseVector = new PgVector({
  connectionString: 'postgresql://postgres.rdvxhipwrwcexrlvzxus:9&G%-z_hzx7S.YA@aws-1-us-east-2.pooler.supabase.com:6543/postgres',
});

const localVector = new PgVector({
  connectionString: process.env.POSTGRES_CONNECTION_STRING || 'postgresql://nikolastanin@localhost:5432/mastra_demo',
});

async function debugDatabase() {
  console.log('🔍 Debugging Database Connections...\n');

  // Test Supabase connection
  console.log('1. Testing Supabase connection...');
  try {
    await supabaseVector.createIndex({
      indexName: 'mastra_vectors',
      dimension: 1536,
      metric: 'cosine',
      indexConfig: {
        type: 'hnsw',
        hnsw: { m: 16, efConstruction: 64 }
      }
    });
    console.log('✅ Supabase index created/verified');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
      console.log('✅ Supabase index already exists');
    } else {
      console.log('❌ Supabase error:', errorMessage);
    }
  }

  // Test local connection
  console.log('\n2. Testing local connection...');
  try {
    await localVector.createIndex({
      indexName: 'mastra_vectors',
      dimension: 1536,
      metric: 'cosine',
      indexConfig: {
        type: 'hnsw',
        hnsw: { m: 16, efConstruction: 64 }
      }
    });
    console.log('✅ Local index created/verified');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
      console.log('✅ Local index already exists');
    } else {
      console.log('❌ Local error:', errorMessage);
    }
  }

  // Dump local table schema
  console.log('\n2.1. Dumping local table schema...');
  try {
    const localClient = new Client({
      connectionString: process.env.POSTGRES_CONNECTION_STRING || 'postgresql://nikolastanin@localhost:5432/mastra_demo',
    });
    
    await localClient.connect();
    
    const schemaQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'mastra_vectors' 
      ORDER BY ordinal_position;
    `;
    
    const schemaResult = await localClient.query(schemaQuery);
    
    console.log('📋 Local table schema:');
    console.table(schemaResult.rows);
    
    // Also check if table exists and get row count
    const countQuery = 'SELECT COUNT(*) as count FROM mastra_vectors';
    const countResult = await localClient.query(countQuery);
    console.log(`📊 Local table has ${countResult.rows[0].count} rows`);
    
    await localClient.end();
    
  } catch (error) {
    console.log('❌ Local schema query error:', error instanceof Error ? error.message : String(error));
  }

  // Test query on Supabase
  console.log('\n3. Testing query on Supabase...');
  try {
    const { embeddings } = await embedMany({
      model: openai.embedding('text-embedding-3-small'),
      values: ['best casino bonuses'],
    });

    const supabaseResults = await supabaseVector.query({
      indexName: 'mastra_vectors',
      queryVector: embeddings[0],
      topK: 5,
      includeVector: false,
    });

    console.log(`Supabase results: ${supabaseResults.length} documents found`);
    if (supabaseResults.length > 0) {
      console.log('Sample result:', {
        score: supabaseResults[0].score,
        text: supabaseResults[0].metadata?.text?.substring(0, 100) + '...',
        metadata: supabaseResults[0].metadata
      });
    }
  } catch (error) {
    console.log('❌ Supabase query error:', error instanceof Error ? error.message : String(error));
  }

  // Test query on local
  console.log('\n4. Testing query on local...');
  try {
    const { embeddings } = await embedMany({
      model: openai.embedding('text-embedding-3-small'),
      values: ['best casino bonuses'],
    });

    const localResults = await localVector.query({
      indexName: 'mastra_vectors',
      queryVector: embeddings[0],
      topK: 5,
      includeVector: false,
    });

    console.log(`Local results: ${localResults.length} documents found`);
    if (localResults.length > 0) {
      console.log('Sample result:', {
        score: localResults[0].score,
        text: localResults[0].metadata?.text?.substring(0, 100) + '...',
        metadata: localResults[0].metadata
      });
    }
  } catch (error) {
    console.log('❌ Local query error:', error instanceof Error ? error.message : String(error));
  }

  // Disconnect
  console.log('\n5. Cleaning up...');
  await supabaseVector.disconnect();
  await localVector.disconnect();
  console.log('✅ Disconnected from both databases');
}

debugDatabase().catch(console.error);
