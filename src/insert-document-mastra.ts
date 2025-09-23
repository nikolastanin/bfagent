import { PgVector } from '@mastra/pg';
import { MDocument } from '@mastra/rag';
import { openai } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables
dotenv.config();

interface DocumentData {
  id: string;
  text: string;
  metadata?: Record<string, any>;
}

class MastraDocumentInserter {
  private pgVector: PgVector;
  private indexName: string;

  constructor() {
    this.pgVector = new PgVector({
      connectionString: process.env.POSTGRES_CONNECTION_STRING || 'postgresql://postgres:password@localhost:5432/mastra',
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
      console.log('Connected to PostgreSQL and ensured index exists');
    } catch (error) {
      console.error('Error connecting to database:', error);
      throw error;
    }
  }

  async disconnect() {
    await this.pgVector.disconnect();
    console.log('Disconnected from database');
  }

  async insertDocument(document: DocumentData): Promise<void> {
    try {
      // Create MDocument from text
      const doc = MDocument.fromText(document.text, {
        id: document.id,
        ...document.metadata
      });

      // Chunk the document
      const chunks = await doc.chunk({
        strategy: 'recursive',
        maxSize: 512,
        overlap: 50,
      });

      console.log(`Generated ${chunks.length} chunks for document: ${document.id}`);

      // Generate embeddings for all chunks
      const { embeddings } = await embedMany({
        model: openai.embedding('text-embedding-3-small'),
        values: chunks.map(chunk => chunk.text),
      });

      // Prepare metadata for each chunk
      const metadata = chunks.map((chunk, index) => ({
        text: chunk.text,
        id: `${document.id}_chunk_${index}`,
        originalId: document.id,
        chunkIndex: index,
        ...chunk.metadata,
        ...document.metadata,
      }));

      // Insert into vector store
      await this.pgVector.upsert({
        indexName: this.indexName,
        vectors: embeddings,
        metadata: metadata,
      });

      console.log(`Successfully inserted document: ${document.id} with ${chunks.length} chunks`);
    } catch (error) {
      console.error('Error inserting document:', error);
      throw error;
    }
  }

  async insertMultipleDocuments(documents: DocumentData[]): Promise<void> {
    console.log(`Inserting ${documents.length} documents...`);
    
    for (const document of documents) {
      await this.insertDocument(document);
    }
    
    console.log('All documents inserted successfully');
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
  const inserter = new MastraDocumentInserter();
  
  try {
    await inserter.connect();

    // Read markdown files from src/files directory
    const filesDir = join(process.cwd(), 'src', 'files');
    
    // Create MDocument instances from markdown files
    const onlineCasinosDoc = MDocument.fromMarkdown(
      readFileSync(join(filesDir, 'online-casinos.md'), 'utf-8'),
      {
        category: 'casino-guide',
        source: 'online-casinos.md',
        type: 'markdown',
        url: 'https://www.bonus.ca/online-casinos',
        title: 'Best 100 Online Casinos & Trusted Sites in Canada 2025',
        createdAt: new Date().toISOString()
      }
    );
    
    const jackpotCityDoc = MDocument.fromMarkdown(
      readFileSync(join(filesDir, 'jackpot-city-casino-review.md'), 'utf-8'),
      {
        category: 'casino-review',
        source: 'jackpot-city-casino-review.md',
        type: 'markdown',
        url: 'https://www.bonus.ca/jackpot-city',
        title: 'Jackpot City Casino',
        createdAt: new Date().toISOString()
      }
    );

    // Chunk the documents
    const onlineCasinosChunks = await onlineCasinosDoc.chunk({
      strategy: 'markdown',
      maxSize: 1000,
      overlap: 100
    });
    
    const jackpotCityChunks = await jackpotCityDoc.chunk({
      strategy: 'markdown',
      maxSize: 1000,
      overlap: 100
    });

    // Convert chunks to DocumentData format
    const documents: DocumentData[] = [
      ...onlineCasinosChunks.map((chunk, index) => ({
        id: `online-casinos-${index}`,
        text: chunk.text,
        metadata: {
          ...chunk.metadata,
          source: 'online-casinos.md',
          url: 'https://www.bonus.ca/online-casinos',
          title: 'Best 100 Online Casinos & Trusted Sites in Canada 2025',
          chunkIndex: index
        }
      })),
      ...jackpotCityChunks.map((chunk, index) => ({
        id: `jackpot-city-${index}`,
        text: chunk.text,
        metadata: {
          ...chunk.metadata,
          source: 'jackpot-city-casino-review.md',
          url: 'https://www.bonus.ca/jackpot-city',
          title: 'Jackpot City Casino',
          chunkIndex: index
        }
      }))
    ];

    // Insert documents
    await inserter.insertMultipleDocuments(documents);

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

export { MastraDocumentInserter, DocumentData };
