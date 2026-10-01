const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Headers para permitir popups de autenticação (Google Auth)
app.use((req, res, next) => {
	res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
	next();
});

// Recomendo fortemente usar o .env para a chave. 
// Se for colar direto aqui, use a nova chave que você vai gerar.
const API_KEY = process.env.GEMINI_API_KEY;


const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${API_KEY}`;

app.post('/api/consultor', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: "O campo prompt é obrigatório." });
    }

    try {
        const response = await axios.post(GEMINI_URL, {
            contents: [{
                parts: [{ 
                    text: `Contexto: Você é um consultor financeiro brasileiro. Responda de forma curta e direta .\n\nPergunta do usuário: ${prompt}` 
                }]
            }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1000,
            }
        });

        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            const textResponse = response.data.candidates[0].content.parts[0].text;
            res.json({ response: textResponse });
        } else {
            throw new Error("Formato de resposta inesperado do Google.");
        }

    } catch (error) {
        console.error("--- ERRO NA API GEMINI ---");
        const status = error.response ? error.response.status : 500;
        const msg = error.response && error.response.data ? error.response.data.error.message : error.message;
        
        console.error("Status:", status);
        console.error("Mensagem:", msg);
        
        res.status(status).json({ 
            error: "Erro ao consultar a IA.",
            details: msg 
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});