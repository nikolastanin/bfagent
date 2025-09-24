import { PgVector } from '@mastra/pg';
import { MDocument } from '@mastra/rag';
import { openai } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import { createHash } from 'crypto';
import { Pool } from 'pg';

interface ContentFile {
  id: string;
  filename: string;
  content: string;
  file_path?: string;
  metadata: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  source_site: string;
  file_hash: string;
  processed_at?: Date;
  error_message?: string;
  location?: string;
  created_at: Date;
  updated_at: Date;
}

interface DocumentData {
  id: string;
  text: string;
  metadata?: Record<string, any>;
}

class SupabaseDocumentInserter {
  private pgVector: PgVector;
  private dbClient: Pool;
  private indexName: string;

  constructor() {
    const connectionString = process.env.SUPABASE_URL || 'postgresql://postgres.rdvxhipwrwcexrlvzxus:9&G%-z_hzx7S.YA@aws-1-us-east-2.pooler.supabase.com:6543/postgres';
    
    this.pgVector = new PgVector({
      connectionString,
    });
    
    this.dbClient = new Pool({
      connectionString,
    });
    
    this.indexName = 'mastra_vectors';
  }

  async connect() {
    try {
      // Create the index if it doesn't exist
      await this.pgVector.createIndex({
        indexName: this.indexName,
        dimension: 1536, // OpenAI text-embedding-3-small dimension
        metric: 'cosine',
        indexConfig: {
          type: 'hnsw', // Use HNSW instead of IVFFlat for higher dimensions
          hnsw: {
            m: 16,
            efConstruction: 64
          }
        }
      });
      console.log('✅ Connected to Supabase and ensured index exists');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage?.includes('already exists') || errorMessage?.includes('relation') || errorMessage?.includes('duplicate')) {
        console.log('✅ Connected to Supabase (index exists)');
      } else {
        console.error('Error connecting to Supabase:', error);
        throw error;
      }
    }
  }

  async disconnect() {
    await this.pgVector.disconnect();
    await this.dbClient.end();
    console.log('Disconnected from Supabase');
  }

  private generateFileHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private async checkExistingFile(fileHash: string): Promise<ContentFile | null> {
    try {
      const query = `
        SELECT * FROM content_files 
        WHERE file_hash = $1 
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      
      const result = await this.dbClient.query(query, [fileHash]);
      return result.rows[0] || null;
    } catch (error) {
      console.log('Could not check existing file, proceeding with insertion:', error);
      return null;
    }
  }

  private async updateContentFileStatus(
    fileHash: string, 
    status: ContentFile['status'], 
    errorMessage?: string
  ): Promise<void> {
    try {
      const query = `
        UPDATE content_files 
        SET status = $1, 
            processed_at = $2, 
            error_message = $3,
            updated_at = NOW()
        WHERE file_hash = $4
      `;
      
      const processedAt = status === 'completed' ? new Date() : null;
      
      await this.dbClient.query(query, [status, processedAt, errorMessage, fileHash]);
      console.log(`Updated file ${fileHash} to status: ${status}`);
    } catch (error) {
      console.error('Error updating content file status:', error);
    }
  }


  async processDocumentFromDB(contentFile: ContentFile, force: boolean = false): Promise<void> {
    const { id, filename, content, file_hash, metadata } = contentFile;
    
    try {
      // Check if file already exists and is up to date (unless force mode)
      if (!force) {
        const existingFile = await this.checkExistingFile(file_hash);
        
        if (existingFile && existingFile.status === 'completed') {
          console.log(`File ${filename} already processed and up to date`);
          return;
        }
      } else {
        console.log(`Force mode: Reprocessing file ${filename}`);
      }

      // Update status to processing
      await this.updateContentFileStatus(file_hash, 'processing');

      // Create MDocument from content
      const doc = MDocument.fromText(content, {
        id: `file_${file_hash}`,
        filename,
        fileId: id,
        ...metadata
      });

      // Chunk the document
      const chunks = await doc.chunk({
        strategy: 'recursive',
        maxSize: 512,
        overlap: 50,
      });

      console.log(`Generated ${chunks.length} chunks for file: ${filename}`);

      // Generate embeddings for all chunks
      const { embeddings } = await embedMany({
        model: openai.embedding('text-embedding-3-small'),
        values: chunks.map(chunk => chunk.text),
      });

      // Prepare metadata for each chunk
      const chunkMetadata = chunks.map((chunk, index) => ({
        text: chunk.text,
        id: `${file_hash}_chunk_${index}`,
        originalFileHash: file_hash,
        originalFileId: id,
        filename,
        chunkIndex: index,
        ...chunk.metadata,
        ...metadata,
      }));

      // Insert into vector store
      await this.pgVector.upsert({
        indexName: this.indexName,
        vectors: embeddings,
        metadata: chunkMetadata,
      });

      // Update status to completed
      await this.updateContentFileStatus(file_hash, 'completed');

      console.log(`✅ Successfully processed file: ${filename} with ${chunks.length} chunks`);
    } catch (error) {
      console.error(`❌ Error processing file ${filename}:`, error);
      
      // Update status to failed
      await this.updateContentFileStatus(
        file_hash, 
        'failed', 
        error instanceof Error ? error.message : String(error)
      );
      
      throw error;
    }
  }

  async getPendingFiles(force: boolean = false): Promise<ContentFile[]> {
    try {
      let query: string;
      let params: any[] = [];
      
      if (force) {
        query = `
          SELECT * FROM content_files 
          ORDER BY created_at ASC
        `;
      } else {
        query = `
          SELECT * FROM content_files 
          WHERE status IN ('pending', 'failed')
          ORDER BY created_at ASC
        `;
      }
      
      const result = await this.dbClient.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Error fetching pending files:', error);
      return [];
    }
  }

  async processPendingFiles(force: boolean = false): Promise<void> {
    const mode = force ? 'all files (force mode)' : 'pending files';
    console.log(`Fetching ${mode} from database...`);
    
    const pendingFiles = await this.getPendingFiles(force);
    console.log(`Found ${pendingFiles.length} files to process`);

    for (const file of pendingFiles) {
      try {
        await this.processDocumentFromDB(file, force);
      } catch (error) {
        console.error(`Failed to process ${file.filename}:`, error);
        // Continue with other files
      }
    }
    
    console.log(`✅ ${mode} processing completed`);
  }

  async queryDocuments(query: string, topK: number = 5): Promise<any[]> {
    try {
      // Generate embedding for the query
      const { embeddings } = await embedMany({
        model: openai.embedding('text-embedding-3-small'),
        values: [query],
      });

      // Query the vector store
      const results = await this.pgVector.query({
        indexName: this.indexName,
        queryVector: embeddings[0],
        topK: topK,
        includeVector: false,
      });

      return results;
    } catch (error) {
      console.error('Error querying documents:', error);
      throw error;
    }
  }
}

// Example usage
async function main() {
  const inserter = new SupabaseDocumentInserter();
  
  // Check for --force flag
  const force = process.argv.includes('--force');
  
  try {
    await inserter.connect();

    // Process files from the content_files table
    await inserter.processPendingFiles(force);

    // Example query
    console.log('\n--- Querying documents ---');
    const queryResults = await inserter.queryDocuments('What are the best online casinos?', 3);
    
    console.log('Query results:');
    queryResults.forEach((result, index) => {
      console.log(`\n${index + 1}. Score: ${result.score.toFixed(4)}`);
      console.log(`   Text: ${result.metadata.text.substring(0, 100)}...`);
      console.log(`   Metadata: ${JSON.stringify(result.metadata, null, 2)}`);
    });

  } catch (error) {
    console.error('Error in main:', error);
  } finally {
    await inserter.disconnect();
  }
}

// Run the script if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { SupabaseDocumentInserter, ContentFile, DocumentData };
