
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
    getFirestore,
    FieldValue
} from "firebase-admin/firestore";

const app = express();

const projeto = process.env.FIREBASE_PROJECT_ID;
const emailServico = process.env.FIREBASE_CLIENT_EMAIL;
const chave = process.env.FIREBASE_PRIVATE_KEY
    ?.replace(/\\n/g, "\n");

if (!projeto || !emailServico || !chave ||
    !process.env.FRONTEND_URL) {
    throw new Error("Variáveis do backend incompletas.");
}

initializeApp({
    credential: cert({
        projectId: projeto,
        clientEmail: emailServico,
        privateKey: chave
    })
});

const auth = getAuth();
const db = getFirestore();

const origens = process.env.FRONTEND_URL
    .split(",")
    .map(valor => valor.trim());

app.use(cors({ origin: origens }));
app.use(express.json({ limit: "16kb" }));

app.use("/api", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
}));

async function autenticar(req, res, next) {
    try {
        const token = req.headers.authorization
            ?.match(/^Bearer (.+)$/)?.[1];

        if (!token) {
            return res.status(401).json({
                erro: "Login necessário."
            });
        }

        const decoded = await auth.verifyIdToken(token, true);
        const usuarioAuth = await auth.getUser(decoded.uid);

        if (usuarioAuth.disabled) {
            return res.status(403).json({
                erro: "Conta desativada."
            });
        }

        const perfilDoc = await db
            .collection("usuarios")
            .doc(decoded.uid)
            .get();

        if (!perfilDoc.exists ||
            perfilDoc.data().ativo !== true) {
            return res.status(403).json({
                erro: "Usuário sem autorização."
            });
        }

        req.usuario = {
            uid: decoded.uid,
            ...perfilDoc.data()
        };

        next();
    } catch (error) {
        return res.status(401).json({
            erro: "Sessão inválida ou expirada."
        });
    }
}

function podeGerenciar(usuario) {
    return [
        "desbloqueio",
        "admin_empresa"
    ].includes(usuario.perfil);
}

app.get("/api/saude", (req, res) => {
    res.json({ status: "online" });
});

// Listagem com isolamento entre empresas.
app.get("/api/usuarios", autenticar, async (req, res) => {
    if (!podeGerenciar(req.usuario)) {
        return res.status(403).json({
            erro: "Sem permissão."
        });
    }

    try {
        let consulta = db.collection("usuarios");

        if (req.usuario.perfil !== "desbloqueio") {
            consulta = consulta.where(
                "empresaId",
                "==",
                req.usuario.empresaId
            );
        }

        const snapshot = await consulta.get();

        const usuarios = snapshot.docs.map(doc => {
            const dados = doc.data();

            return {
                id: doc.id,
                nome: dados.nome,
                email: dados.email,
                perfil: dados.perfil,
                empresaId: dados.empresaId ?? null,
                ativo: dados.ativo === true
            };
        });

        usuarios.sort((a, b) =>
            a.nome.localeCompare(b.nome, "pt-BR")
        );

        res.json(usuarios);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            erro: "Erro ao consultar usuários."
        });
    }
});

app.post("/api/usuarios", autenticar, async (req, res) => {
    if (!podeGerenciar(req.usuario)) {
        return res.status(403).json({
            erro: "Sem permissão para cadastrar."
        });
    }

    const { nome, email, senha, perfil } = req.body ?? {};
    let { empresaId } = req.body ?? {};

    const perfisPermitidos = req.usuario.perfil === "desbloqueio"
        ? ["admin_empresa", "vendedor", "acompanhamento"]
        : ["vendedor", "acompanhamento"];

    if (!perfisPermitidos.includes(perfil)) {
        return res.status(403).json({
            erro: "Perfil não autorizado."
        });
    }

    if (req.usuario.perfil === "admin_empresa") {
        empresaId = req.usuario.empresaId;
    }

    if (typeof empresaId !== "string" ||
        !empresaId.trim()) {
        return res.status(400).json({
            erro: "Empresa obrigatória."
        });
    }

    if (typeof nome !== "string" ||
        nome.trim().length < 3 ||
        nome.trim().length > 120 ||
        typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof senha !== "string" ||
        senha.length < 12 ||
        senha.length > 128) {
        return res.status(400).json({
            erro: "Confira nome, e-mail e senha (mínimo 12 caracteres)."
        });
    }

    try {
        const empresa = await db
            .collection("empresas")
            .doc(empresaId)
            .get();

        if (!empresa.exists ||
            empresa.data().ativo !== true) {
            return res.status(400).json({
                erro: "Empresa inexistente ou inativa."
            });
        }

        let novoUsuario;

        try {
            novoUsuario = await auth.createUser({
                email: email.trim().toLowerCase(),
                password: senha,
                displayName: nome.trim(),
                disabled: false
            });
        } catch (error) {
            if (error.code === "auth/email-already-exists") {
                return res.status(409).json({
                    erro: "Este e-mail já está cadastrado."
                });
            }
            throw error;
        }

        try {
            await db.collection("usuarios")
                .doc(novoUsuario.uid)
                .create({
                    nome: nome.trim(),
                    email: email.trim().toLowerCase(),
                    empresaId,
                    perfil,
                    ativo: true,
                    criadoEm: FieldValue.serverTimestamp(),
                    criadoPor: req.usuario.uid
                });
        } catch (error) {
            // Compensação em caso de falha no Firestore.
            try {
                await auth.deleteUser(novoUsuario.uid);
            } catch (rollbackError) {
                console.error("Falha ao reverter conta:", {
                    uid: novoUsuario.uid,
                    rollbackError
                });
            }
            throw error;
        }

        return res.status(201).json({
            mensagem: "Usuário cadastrado.",
            uid: novoUsuario.uid
        });
    } catch (error) {
        const referencia = crypto.randomUUID();
        console.error("Erro de cadastro:", referencia, error);

        return res.status(500).json({
            erro: "Não foi possível concluir o cadastro.",
            referencia
        });
    }
});

app.listen(process.env.PORT || 10000, "0.0.0.0", () => {
    console.log("API de desbloqueios iniciada.");
});
