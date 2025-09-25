import { PgVector } from '@mastra/pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testDatabaseConnection(connectionString: string, dbName: string) {
  console.log(`\n🔍 Testing ${dbName} connection...`);
  console.log(`Connection string: ${connectionString.substring(0, 50)}...`);
  
  try {
    const vector = new PgVector({
      connectionString: connectionString,
    });
    
    // Test basic connection by trying to create an index
    await vector.createIndex({
      indexName: 'test_connection',
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
    
    console.log(`✅ ${dbName} connection successful!`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
      console.log(`✅ ${dbName} connection successful! (index already exists)`);
      return true;
    }
    
    console.error(`❌ ${dbName} connection failed:`, errorMessage);
    return false;
  }
}

async function main() {
  console.log('🚀 Testing database connections...\n');
  
  // Test local PostgreSQL connection
  const localConnectionString = process.env.POSTGRES_CONNECTION_STRING || '';
  if (localConnectionString) {
    // Fix the connection string if it has the -- prefix
    const fixedLocalConnectionString = localConnectionString.startsWith('--postgresql://') 
      ? localConnectionString.replace('--postgresql://', 'postgresql://')
      : localConnectionString;
    
    await testDatabaseConnection(fixedLocalConnectionString, 'Local PostgreSQL');
  } else {
    console.log('⚠️ POSTGRES_CONNECTION_STRING not set, skipping local database test');
  }
  
  // Test Supabase connection
  const supabaseConnectionString = process.env.SUPABASE_URL || '';
  if (supabaseConnectionString) {
    await testDatabaseConnection(supabaseConnectionString, 'Supabase');
  } else {
    console.log('⚠️ SUPABASE_URL not set, skipping Supabase test');
  }
  
  console.log('\n🏁 Database connection tests completed!');
}

main().catch(console.error);
