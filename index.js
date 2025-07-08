import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import 'dotenv/config';
import { OpenAI } from 'openai';
import pdfParse from 'pdf-parse';

const perplexity = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: 'https://api.perplexity.ai',
});

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

// Utility: Extract text from buffer, handling both PDF and TXT
async function extractText(buffer, ext) {
    if (ext === '.txt') {
        return buffer.toString('utf-8');
    } else if (ext === '.pdf') {
        try {
            const data = await pdfParse(buffer);
            return data.text;
        } catch (error) {
            console.error('Error extracting text from PDF:', error);
            throw new Error('Failed to extract text from PDF');
        }
    } else {
        throw new Error('Unsupported file type');
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
        console.log('Received files:', req.files);
        // Validate file presence
        if (!req.files?.jobDescription || !req.files?.resumes) {
            return res.status(400).json({ error: 'Missing job description or resumes.' });
        }

        // Job Description
        const jdFile = req.files.jobDescription[0];
        const jdExt = path.extname(jdFile.originalname).toLowerCase();
        if (!['.txt', '.pdf'].includes(jdExt)) {
            return res.status(400).json({ error: 'Unsupported job description file type.' });
        }
        let jdText = await extractText(jdFile.buffer, jdExt);

        // Resumes
        const candidates = [];
        for (const resume of req.files.resumes) {
            const resumeExt = path.extname(resume.originalname).toLowerCase();
            if (!['.txt', '.pdf'].includes(resumeExt)) {
                console.error(`Unsupported resume file type: ${resume.originalname}`);
                continue;
            }
            let resumeText;
            try {
                resumeText = await extractText(resume.buffer, resumeExt);
            } catch (err) {
                console.error(`Failed to extract text from ${resume.originalname}:`, err.message);
                continue;
            }

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
        candidates.sort((a, b) => b.score - a.score);
        res.json(candidates);
    } catch (error) {
        console.error('Error processing files:', error);
        res.status(500).json({
            error: 'Processing failed',
            details: error.message
        });
    }
});

// --- Robust analyzeFit function (unchanged, for brevity) ---
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
            max_tokens: 600,
            temperature: 0.2
        });

        let content = response.choices && response.choices[0]?.message?.content
            ? response.choices[0].message.content
            : "";
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                try {
                    parsed = JSON.parse(match[0]);
                } catch (e2) {
                    throw new Error("Could not parse JSON from model response: " + content);
                }
            } else {
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
