import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";

export function registrarAgendamentos(app, { db, autenticar }) {
    const router = Router();

    router.use(autenticar);

    const perfis = [
        "desbloqueio",
        "admin_empresa",
        "acompanhamento",
        "vendedor"
    ];

    function autorizado(req, res) {
        if (!perfis.includes(req.usuario.perfil)) {
            res.status(403).json({ erro: "Sem permissão." });
            return false;
        }
        return true;
    }

    function somenteNumeros(valor) {
        return String(valor ?? "").replace(/\D/g, "");
    }

    function cpfValido(cpf) {
        if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) {
            return false;
        }

        for (let digito = 9; digito <= 10; digito++) {
            let soma = 0;

            for (let i = 0; i < digito; i++) {
                soma += Number(cpf[i]) * (digito + 1 - i);
            }

            let verificador = (soma * 10) % 11;
            if (verificador === 10) verificador = 0;

            if (verificador !== Number(cpf[digito])) {
                return false;
            }
        }

        return true;
    }

    function dataValida(data) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
            return false;
        }

        const [ano, mes, dia] = data.split("-").map(Number);
        const objeto = new Date(Date.UTC(ano, mes - 1, dia));

        return objeto.toISOString().slice(0, 10) === data;
    }

    function dataHoje() {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Sao_Paulo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(new Date());
    }

    // Retorna vendedores da empresa autorizada.
    router.get("/vendedores", async (req, res) => {
        if (!autorizado(req, res)) return;

        try {
            let empresaId = req.usuario.empresaId;

            if (req.usuario.perfil === "desbloqueio") {
                empresaId = req.query.empresaId;
            }

            if (typeof empresaId !== "string" || !empresaId) {
                return res.status(400).json({
                    erro: "Informe uma empresa."
                });
            }

            const snapshot = await db.collection("usuarios")
                .where("empresaId", "==", empresaId)
                .get();

            const vendedores = snapshot.docs
                .filter(doc =>
                    doc.data().perfil === "vendedor" &&
                    doc.data().ativo === true
                )
                .map(doc => ({
                    id: doc.id,
                    nome: doc.data().nome
                }));

            res.json(vendedores);
        } catch (erro) {
            console.error(erro);
            res.status(500).json({
                erro: "Erro ao consultar vendedores."
            });
        }
    });

    // Cadastra um agendamento.
    router.post("/", async (req, res) => {
        if (!autorizado(req, res)) return;

        const dados = req.body ?? {};

        const nome = typeof dados.nome === "string"
            ? dados.nome.trim() : "";

        const cpf = somenteNumeros(dados.cpf);
        const telefone = somenteNumeros(dados.telefone);

        const proposta = typeof dados.proposta === "string"
            ? dados.proposta.trim() : "";

        const data = dados.data;
        const horario = dados.horario;

        if (nome.length < 3 || nome.length > 120 ||
            !cpfValido(cpf) ||
            !/^\d{10,11}$/.test(telefone) ||
            !proposta || proposta.length > 80 ||
            !dataValida(data) ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario) ||
            data < dataHoje()) {
            return res.status(400).json({
                erro: "Verifique os dados do agendamento."
            });
        }

        try {
            const global = req.usuario.perfil === "desbloqueio";

            const empresaId = global
                ? dados.empresaId
                : req.usuario.empresaId;

            if (typeof empresaId !== "string" || !empresaId) {
                return res.status(400).json({
                    erro: "Empresa obrigatória."
                });
            }

            const empresaRef = db.collection("empresas")
                .doc(empresaId);

            const empresa = await empresaRef.get();

            if (!empresa.exists || empresa.data().ativo !== true) {
                return res.status(403).json({
                    erro: "Empresa não autorizada."
                });
            }

            const ehVendedor = req.usuario.perfil === "vendedor";

            const vendedorId = ehVendedor
                ? req.usuario.uid
                : dados.vendedorId;

            if (typeof vendedorId !== "string" || !vendedorId) {
                return res.status(400).json({
                    erro: "Selecione o vendedor."
                });
            }

            const vendedorRef = db.collection("usuarios")
                .doc(vendedorId);

            const vendedor = await vendedorRef.get();

            if (!vendedor.exists ||
                vendedor.data().ativo !== true ||
                vendedor.data().perfil !== "vendedor" ||
                vendedor.data().empresaId !== empresaId) {
                return res.status(403).json({
                    erro: "Vendedor não autorizado para a empresa."
                });
            }

            const slotId = `${data}_${horario.replace(":", "-")}`;

            const slotRef = db.collection("agenda_slots")
                .doc(slotId);

            const agendamentoRef = db.collection("agendamentos")
                .doc();

            const confirmado = dados.confirmarAltaDemanda === true;

            const resultado = await db.runTransaction(async transacao => {
                const slot = await transacao.get(slotRef);
                const quantidade = slot.exists
                    ? slot.data().quantidade
                    : 0;

                if (quantidade >= 5 && !confirmado) {
                    return {
                        aviso: true,
                        quantidade
                    };
                }

                transacao.set(slotRef, {
                    data,
                    horario,
                    quantidade: quantidade + 1,
                    atualizadoEm: FieldValue.serverTimestamp()
                });

                transacao.create(agendamentoRef, {
                    nome,
                    cpf,
                    telefone,
                    proposta,
                    data,
                    horario,
                    empresaId,
                    vendedorId,
                    vendedorNome: vendedor.data().nome,
                    criadoPor: req.usuario.uid,
                    status: "agendado",
                    criadoEm: FieldValue.serverTimestamp()
                });

                return {
                    aviso: false,
                    id: agendamentoRef.id
                };
            });

            if (resultado.aviso) {
                return res.status(409).json({
                    codigo: "ALTA_DEMANDA",
                    quantidade: resultado.quantidade,
                    mensagem:
                        "Existem muitos agendamentos pra esse horário, " +
                        "o atendimento pode demorar um pouco. " +
                        "Deseja continuar?"
                });
            }

            return res.status(201).json({
                mensagem: "Agendamento cadastrado com sucesso!",
                id: resultado.id
            });

        } catch (erro) {
            console.error(erro);
            res.status(500).json({
                erro: "Erro ao registrar agendamento."
            });
        }
    });

    // Lista somente os agendamentos permitidos.

    router.get("/", async (req, res) => {
        if (!autorizado(req, res)) return;

        try {
            const limite = Math.min(
                Math.max(Number.parseInt(req.query.limite, 10) || 50, 1),
                50
            );

            const cursor = typeof req.query.cursor === "string"
                ? req.query.cursor
                : null;

            const data = req.query.data;
            const status = req.query.status;

            let consulta = db.collection("agendamentos");

            // Segurança: aplicar escopo ANTES dos filtros.
            if (req.usuario.perfil === "vendedor") {
                consulta = consulta.where(
                    "vendedorId", "==", req.usuario.uid
                );
            } else if (req.usuario.perfil !== "desbloqueio") {
                consulta = consulta.where(
                    "empresaId", "==", req.usuario.empresaId
                );
            }

            // Filtros opcionais.
            if (data) {
                if (typeof data !== "string" ||
                    !dataValida(data)) {
                    return res.status(400).json({
                        erro: "Data inválida."
                    });
                }

                consulta = consulta.where("data", "==", data);
            }

            if (status) {
                const permitidos = [
                    "agendado",
                    "em_atendimento",
                    "concluido",
                    "nao_atendeu",
                    "reagendado"
                ];

                if (typeof status !== "string" ||
                    !permitidos.includes(status)) {
                    return res.status(400).json({
                        erro: "Situação inválida."
                    });
                }

                consulta = consulta.where("status", "==", status);
            }

            consulta = consulta.orderBy(
                "__name__", "asc"
            );

            // Cursor referente ao último documento
            // da página anterior.
            if (cursor) {
                const documento = await db
                    .collection("agendamentos")
                    .doc(cursor)
                    .get();

                if (!documento.exists) {
                    return res.status(400).json({
                        erro: "Cursor inválido."
                    });
                }

                // Não permite utilizar cursor de outra empresa
                // ou de outro vendedor.
                const dados = documento.data();

                if (
                    req.usuario.perfil === "vendedor" &&
                    dados.vendedorId !== req.usuario.uid
                ) {
                    return res.status(403).json({
                        erro: "Cursor não autorizado."
                    });
                }

                if (
                    req.usuario.perfil !== "desbloqueio" &&
                    dados.empresaId !== req.usuario.empresaId
                ) {
                    return res.status(403).json({
                        erro: "Cursor não autorizado."
                    });
                }

                consulta = consulta.startAfter(documento);
            }

            const snapshot = await consulta.limit(limite + 1).get();

            const temMais = snapshot.docs.length > limite;
            const documentos = snapshot.docs.slice(0, limite);

            const agendamentos = documentos.map(doc => ({
                id: doc.id,
                ...doc.data(),
                criadoEm: doc.data().criadoEm?.toDate()
                    ?.toISOString() ?? null
            }));

            return res.json({
                agendamentos,
                proximoCursor: temMais
                    ? documentos[documentos.length - 1].id
                    : null,
                temMais
            });

        } catch (error) {
            console.error("Erro ao consultar agenda:", error);

            return res.status(500).json({
                erro: "Erro ao carregar agendamentos."
            });
        }
    });

    // Registrar as rotas de agendamentos na API
    app.use("/api/agendamentos", router);
}
