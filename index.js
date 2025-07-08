const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { OpenAI } = require('openai');
const pdfParse = require('pdf-parse');

const perplexity = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: 'https://api.perplexity.ai',
});

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

async function extractText(pdfBuffer) {
    try {
        const data = await pdfParse(pdfBuffer);
        console.log(`Extracted text from PDF: ${data.text.substring(0, 100)}...`); // Log first 100 chars for debugging
        return data.text;
    } catch (error) {
        console.error('Error extracting text from PDF:', error);
        throw new Error('Failed to extract text from PDF');
    }
}

app.get("/", (req, res) => {
    res.send("Welcome to the Resume Analyzer API");
});

app.post('/analyze', upload.fields([
    { name: 'jobDescription', maxCount: 1 },
    { name: 'resumes', maxCount: 10 }
]), async (req, res) => {
    try {
        const jdFile = req.files.jobDescription[0];
        let jdText = '';
        const ext = path.extname(jdFile.originalname).toLowerCase();
        console.log(`Received job description file: ${jdFile.originalname} (${ext})`);

        if (ext === '.txt') {
            jdText = jdFile.buffer.toString('utf-8');
        } else if (ext === '.pdf') {
            jdText = await extractText(jdFile.buffer);
        } else {
            return res.status(400).json({ error: 'Unsupported job description file type.' });
        }

        const candidates = [];
        for (const resume of req.files.resumes) {
            const resumeText = await extractText(resume.buffer);

            const analysis = await analyzeFit(jdText, resumeText);
            if (isNaN(analysis.score)) {
                console.error(`Invalid score for resume ${resume.originalname}`);
                continue;
            }
            candidates.push({
                name: resume.originalname,
                ...analysis
            });
        }
        console.log(`JD Text : ${jdText.substring(0, 100)}...`); // Log first 100 chars of JD for debugging
        console.log(`Resume Text : ${candidates.map(c => c.name).join(', ')}`);
        candidates.sort((a, b) => b.score - a.score);
        console.log(`Processed ${candidates.length} resumes for job description: ${jdFile.originalname}`);
        res.json(candidates);
    } catch (error) {
        console.error('Error processing files:', error);
        res.status(500).json({
            error: 'Processing failed',
            details: error.message,
            stack: error.stack
        });
    }
});

// --- Robust analyzeFit function ---
async function analyzeFit(jd, resume) {
    const MAX_LENGTH = 12000;
    const truncatedJD = jd && jd.length > MAX_LENGTH ? jd.substring(0, MAX_LENGTH) : jd || '';
    const truncatedResume = resume && resume.length > MAX_LENGTH ? resume.substring(0, MAX_LENGTH) : resume || '';

    const prompt = `
Evaluate the following resume for the given job description. Respond ONLY with a valid JSON object with the following keys:
- "score" (number, 0-100): Numeric fit score.
- "reasoning": Concise explanation for the score (max 2 sentences).
- "improvements": Array of up to 2 actionable suggestions for the candidate.
- "metrics": Array of up to 5 key criteria or skills matched/missing.

Job Description:
${truncatedJD}

Resume:
${truncatedResume}
`;

    try {
        const response = await perplexity.chat.completions.create({
            model: "sonar-pro",
            messages: [
                { role: "system", content: "Be precise and concise. Respond ONLY with a valid JSON object, no markdown, no explanation." },
                { role: "user", content: prompt }
            ],
            max_tokens: 600, // Increased for safety
            temperature: 0.2
        });

        let content = response.choices && response.choices[0]?.message?.content
            ? response.choices[0].message.content
            : "";
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            // Try to extract JSON from markdown or extra text
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    parsed = JSON.parse(match[0]);
                } catch (e2) {
                    console.error("Second JSON parse attempt failed:", e2, "\nRaw content:", content);
                    throw new Error("Could not parse JSON from model response: " + content);
                }
            } else {
                console.error("No JSON object found in model response. Raw content:", content);
                throw new Error("Could not parse JSON from model response: " + content);
            }
        }

        return {
            score: parsed.score ?? 0,
            reasoning: parsed.reasoning ?? "",
            improvements: parsed.improvements ?? [],
            metrics: parsed.metrics ?? [],
        };
    } catch (e) {
        console.error('Perplexity API error:', e.message, e);
        return {
            score: 0,
            reasoning: "Could not analyze.",
            improvements: [],
            metrics: [],
        };
    }
}

app.listen(3000, () => console.log("Server is running on port 3000"));
