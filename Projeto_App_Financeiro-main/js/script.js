import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, signInAnonymously, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, initializeFirestore, doc, getDoc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- CONFIGURACAO BACKEND ---
const BACKEND_URL = "https://projeto-app-financeiro.onrender.com/api/consultor";

// --- CONSTANTES ---
const SAVING_TIPS = [
	"Pague-se primeiro: reserve uma parte da sua renda antes das contas.",
	"Regra dos 30 dias: se quiser algo, espere 30 dias antes de comprar.",
	"Analise suas assinaturas mensais e cancele o que nao usa.",
	"Evite ir ao supermercado com fome e leve sempre uma lista.",
	"Pequenos gastos diarios podem somar uma fortuna no final do ano.",
	"Compare precos em pelo menos tres sites antes de uma compra grande.",
	"Mantenha uma reserva de emergencia para evitar juros futuros.",
	"Use a regra 50-30-20 para organizar sua renda.",
	"Troque marcas famosas por marcas proprias para economizar.",
	"Compre roupas fora de temporada para aproveitar descontos maiores."
];

const EXPENSE_SUBTYPES = [
	{ name: "Alimentacao", icon: "utensils" }, { name: "Transporte", icon: "car" }, { name: "Saude", icon: "heart-pulse" },
	{ name: "Lazer", icon: "gamepad-2" }, { name: "Supermercado", icon: "store" }, { name: "Moradia", icon: "home" },
	{ name: "Educacao", icon: "graduation-cap" }, { name: "Compras", icon: "shopping-bag" }, { name: "Assinaturas", icon: "tv" },
	{ name: "Presentes", icon: "gift" }, { name: "Dividas", icon: "credit-card" }, { name: "Investimento", icon: "line-chart" },
	{ name: "Beleza", icon: "sparkles" }, { name: "Pets", icon: "paw-print" }, { name: "Viagem", icon: "plane" }, { name: "Outros", icon: "more-horizontal" }
];

const INCOME_SUBTYPES = [
	{ name: "Salario", icon: "wallet" },
	{ name: "Freelance", icon: "briefcase" },
	{ name: "Venda", icon: "trending-up" },
	{ name: "Comissao", icon: "badge-dollar-sign" },
	{ name: "Bonus", icon: "award" },
	{ name: "Decimo Terceiro", icon: "gift" },
	{ name: "Rendimentos", icon: "line-chart" },
	{ name: "Aluguel", icon: "building" },
	{ name: "Reembolso", icon: "receipt" },
	{ name: "Presente", icon: "hand-heart" },
	{ name: "Cashback", icon: "coins" },
	{ name: "Outros", icon: "plus" }
];

// --- ESTADO ---
function createInitialState() {
	return {
		balance: 0, totalIn: 0, totalOut: 0, totalSaved: 0,
		transactions: [], piggyBanks: [],
		budgets: { Alimentacao: 0, Transporte: 0, Lazer: 0, Saude: 0, Supermercado: 0, Moradia: 0, Educacao: 0, Compras: 0, Assinaturas: 0, Presentes: 0, Dividas: 0, Investimento: 0, Beleza: 0, Pets: 0, Viagem: 0, Outros: 0 },
		userStats: { xp: 0, level: 1 }, activeTab: "home", modalType: "expense", selectedSubtype: "Alimentacao", currentTipIndex: 0, lastUpdated: null
	};
}

let state = createInitialState();
let celebratedPiggyIds = new Set();
let editContext = null;
let deleteContext = null;
let undoTimer = null;
let pendingUndoSnapshot = null;
const UNDO_WINDOW_MS = 5000;
const EDIT_MODAL_ANIMATION_MS = 240;
const DELETE_MODAL_ANIMATION_MS = 220;

const LOCAL_STATE_KEY = "carteira_plus_state_v1";
const SOUND_ENABLED_KEY = "carteira_plus_sound_enabled_v1";
let isSoundEnabled = true;

function nowIso() {
	return new Date().toISOString();
}

function toTimestampMs(value) {
	if (!value) return 0;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? 0 : ms;
}

function hasMeaningfulData(data) {
	if (!data) return false;
	const totalIn = Number(data.totalIn || 0);
	const totalOut = Number(data.totalOut || 0);
	const totalSaved = Number(data.totalSaved || 0);
	const transactions = Array.isArray(data.transactions) ? data.transactions.length : 0;
	const piggies = Array.isArray(data.piggyBanks) ? data.piggyBanks.length : 0;
	const xp = Number(data?.userStats?.xp || 0);

	return totalIn > 0 || totalOut > 0 || totalSaved > 0 || transactions > 0 || piggies > 0 || xp > 0;
}

function saveLocalState() {
	try {
		state.lastUpdated = nowIso();
		localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
		console.log("[LocalStorage] Dados salvos:", { transactions: state.transactions.length, totalIn: state.totalIn, totalOut: state.totalOut });
	} catch (e) {
		console.warn("Falha ao salvar localmente:", e?.message || e);
	}
}

function loadLocalState() {
	try {
		const raw = localStorage.getItem(LOCAL_STATE_KEY);
		if (!raw) {
			console.log("[LocalStorage] Nenhum dado no cache");
			return;
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return;

		state = {
			...state,
			...parsed,
			activeTab: "home",
			budgets: { ...state.budgets, ...(parsed.budgets || {}) },
			userStats: { ...state.userStats, ...(parsed.userStats || {}) },
			transactions: Array.isArray(parsed.transactions) ? parsed.transactions : state.transactions,
			piggyBanks: Array.isArray(parsed.piggyBanks) ? parsed.piggyBanks : state.piggyBanks
		};
		console.log("[LocalStorage] Dados carregados:", { transactions: parsed.transactions?.length || 0, totalIn: parsed.totalIn, totalOut: parsed.totalOut });
	} catch (e) {
		console.warn("Falha ao carregar dados locais:", e?.message || e);
	}
}

// --- FIREBASE ---
let auth, db, provider, appId, currentUser, firestoreUnsubscribe;
let isGoogleLoginInProgress = false;
let activeCloudPath = "primary";
let lastSyncedAuthUid = null;
let pendingCloudSync = false;
let cloudRecoveryTimer = null;

const CLOUD_READ_MAX_RETRIES = 3;
const CLOUD_READ_RETRY_MS = 900;
const CLOUD_RECOVERY_INTERVAL_MS = 12000;

const firebaseConfig = {
	apiKey: "AIzaSyCnvNZji4WxV42Gqlfdxed1sQvqBPTTAxs",
	authDomain: "carteiraplus.firebaseapp.com",
	projectId: "carteiraplus",
	storageBucket: "carteiraplus.firebasestorage.app",
	messagingSenderId: "309101161038",
	appId: "1:309101161038:web:efbc23f5d455989cde711f",
	measurementId: "G-EZ27B161DY"
};

appId = firebaseConfig.appId;

function getPrimaryUserDocRef(user) {
	return doc(db, "users", user.uid, "finances", "data");
}

function getLegacyUserDocRef(user) {
	return doc(db, "artifacts", appId, "users", user.uid, "finances", "data");
}

function getUserDocRef(user, pathMode = activeCloudPath) {
	return pathMode === "legacy" ? getLegacyUserDocRef(user) : getPrimaryUserDocRef(user);
}

function getFirebaseErrorCode(error) {
	if (!error) return "";
	return String(error.code || error?.name || "");
}

function isPermissionError(error) {
	const code = getFirebaseErrorCode(error);
	return code.includes("permission-denied") || code.includes("PERMISSION_DENIED");
}

function isUnavailableError(error) {
	const code = getFirebaseErrorCode(error);
	return code.includes("unavailable") || code.includes("offline");
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopCloudRecoveryScheduler() {
	if (!cloudRecoveryTimer) return;
	clearInterval(cloudRecoveryTimer);
	cloudRecoveryTimer = null;
}

function startCloudRecoveryScheduler() {
	if (cloudRecoveryTimer) return;
	cloudRecoveryTimer = setInterval(async () => {
		if (!pendingCloudSync || !currentUser) return;
		try {
			console.log("[CloudRecovery] Tentando restabelecer sincronizacao...");
			await ensureLatestStateForUser(currentUser);
			listenToCloud(currentUser);
			pendingCloudSync = false;
			showToast("Conexao com a nuvem restabelecida.", 2200);
			console.log("[CloudRecovery] Sincronizacao restabelecida com sucesso.");
		} catch (error) {
			if (!isUnavailableError(error)) {
				console.warn("[CloudRecovery] Falha nao transitória:", error?.message || error);
			}
		}
	}, CLOUD_RECOVERY_INTERVAL_MS);
}

function mergeCloudIntoState(cloudData) {
	state = {
		...state,
		...cloudData,
		activeTab: "home",
		budgets: { ...state.budgets, ...(cloudData.budgets || {}) },
		userStats: { ...state.userStats, ...(cloudData.userStats || {}) },
		transactions: Array.isArray(cloudData.transactions) ? cloudData.transactions : state.transactions,
		piggyBanks: Array.isArray(cloudData.piggyBanks) ? cloudData.piggyBanks : state.piggyBanks
	};
}

async function setDocWithFallback(user, payload) {
	const primaryRef = getPrimaryUserDocRef(user);
	const legacyRef = getLegacyUserDocRef(user);

	const primaryAttempt = await setDoc(primaryRef, payload, { merge: true }).then(() => ({ ok: true, mode: "primary" })).catch((e) => ({ ok: false, err: e }));
	if (primaryAttempt.ok) {
		activeCloudPath = "primary";
		return;
	}

	const legacyAttempt = await setDoc(legacyRef, payload, { merge: true }).then(() => ({ ok: true, mode: "legacy" })).catch((e) => ({ ok: false, err: e }));
	if (legacyAttempt.ok) {
		activeCloudPath = "legacy";
		return;
	}

	throw legacyAttempt.err || primaryAttempt.err;
}

async function setDocToBothPaths(user, payload) {
	const primaryRef = getPrimaryUserDocRef(user);
	const legacyRef = getLegacyUserDocRef(user);
	const [primaryRes, legacyRes] = await Promise.allSettled([
		setDoc(primaryRef, payload, { merge: true }),
		setDoc(legacyRef, payload, { merge: true })
	]);

	if (primaryRes.status === "fulfilled") {
		console.log("[CloudWrite] OK caminho primario");
	} else {
		console.warn("[CloudWrite] FALHA caminho primario:", getFirebaseErrorCode(primaryRes.reason));
	}

	if (legacyRes.status === "fulfilled") {
		console.log("[CloudWrite] OK caminho legado");
	} else {
		console.warn("[CloudWrite] FALHA caminho legado:", getFirebaseErrorCode(legacyRes.reason));
	}

	if (primaryRes.status === "fulfilled") {
		activeCloudPath = "primary";
		return;
	}

	if (legacyRes.status === "fulfilled") {
		activeCloudPath = "legacy";
		return;
	}

	throw legacyRes.reason || primaryRes.reason;
}

async function fetchLatestCloudState(user) {
	const [primaryRes, legacyRes] = await Promise.allSettled([
		getDoc(getPrimaryUserDocRef(user)),
		getDoc(getLegacyUserDocRef(user))
	]);

	if (primaryRes.status === "rejected") {
		console.warn("[CloudRead] Falha caminho primario:", getFirebaseErrorCode(primaryRes.reason));
	}
	if (legacyRes.status === "rejected") {
		console.warn("[CloudRead] Falha caminho legado:", getFirebaseErrorCode(legacyRes.reason));
	}

	if (primaryRes.status === "rejected" && legacyRes.status === "rejected") {
		throw primaryRes.reason || legacyRes.reason;
	}

	let primaryData = null;
	let legacyData = null;

	if (primaryRes.status === "fulfilled" && primaryRes.value.exists()) {
		primaryData = primaryRes.value.data() || {};
	}
	if (legacyRes.status === "fulfilled" && legacyRes.value.exists()) {
		legacyData = legacyRes.value.data() || {};
	}

	if (!primaryData && !legacyData) return { data: null, source: null };

	const primaryTs = toTimestampMs(primaryData?.lastUpdated);
	const legacyTs = toTimestampMs(legacyData?.lastUpdated);

	if (primaryData && !legacyData) {
		activeCloudPath = "primary";
		return { data: primaryData, source: "primary" };
	}
	if (legacyData && !primaryData) {
		activeCloudPath = "legacy";
		return { data: legacyData, source: "legacy" };
	}

	if (primaryTs >= legacyTs) {
		activeCloudPath = "primary";
		return { data: primaryData, source: "primary" };
	}

	activeCloudPath = "legacy";
	return { data: legacyData, source: "legacy" };
}

async function fetchLatestCloudStateWithRetry(user) {
	let lastErr = null;
	for (let attempt = 1; attempt <= CLOUD_READ_MAX_RETRIES; attempt++) {
		try {
			return await fetchLatestCloudState(user);
		} catch (err) {
			lastErr = err;
			if (!isUnavailableError(err) || attempt === CLOUD_READ_MAX_RETRIES) {
				throw err;
			}
			console.warn(`[CloudRead] Tentativa ${attempt} falhou (offline/unavailable). Repetindo...`);
			await sleep(CLOUD_READ_RETRY_MS * attempt);
		}
	}
	throw lastErr;
}

async function ensureLatestStateForUser(user) {
	if (!db || !user) return;
	const { data: cloudData } = await fetchLatestCloudStateWithRetry(user);

	const localTs = toTimestampMs(state.lastUpdated);
	const localHasMeaning = hasMeaningfulData(state);
	const cloudHasMeaning = hasMeaningfulData(cloudData);
	const cloudTs = cloudData ? toTimestampMs(cloudData.lastUpdated) : 0;

	console.log("[Sync] Local:", { ts: localTs, meaningful: localHasMeaning, total: state.totalIn + state.totalOut });
	console.log("[Sync] Cloud:", { ts: cloudTs, meaningful: cloudHasMeaning, data: !!cloudData });

	if (!cloudData || !cloudHasMeaning) {
		if (localHasMeaning) {
			console.log("[Sync] Usando dados locais (nuvem vazia). Salvando...");
			if (!state.lastUpdated) state.lastUpdated = nowIso();
			saveLocalState();
			await setDocToBothPaths(user, { ...state });
			const verify = await fetchLatestCloudStateWithRetry(user);
			console.log("[Sync] Verificacao pos-gravacao:", {
				cloudData: !!verify.data,
				cloudTs: toTimestampMs(verify.data?.lastUpdated),
				source: verify.source || "none"
			});
			if (!verify.data) {
				throw new Error("Falha ao confirmar persistencia em nuvem apos escrita.");
			}
			return;
		}
		console.log("[Sync] Ambos vazios. Inicializando...");
		if (!state.lastUpdated) state.lastUpdated = nowIso();
		await setDocToBothPaths(user, { ...state });
		return;
	}

	if (localTs > cloudTs && localHasMeaning) {
		console.log("[Sync] Local mais recente. Enviando...");
		state.lastUpdated = nowIso();
		saveLocalState();
		await setDocToBothPaths(user, { ...state });
		return;
	}

	console.log("[Sync] Usando dados da nuvem");
	mergeCloudIntoState(cloudData);

	saveLocalState();
	updateUI();
	updateNavButtons(state.activeTab);
}

const tryInitFirebase = async () => {
	try {
		const appInstance = initializeApp(firebaseConfig);
		auth = getAuth(appInstance);
		try {
			db = initializeFirestore(appInstance, {
				experimentalAutoDetectLongPolling: true,
				useFetchStreams: false
			});
		} catch (firestoreInitError) {
			console.warn("[Firestore] Fallback para configuracao padrao:", firestoreInitError?.message || firestoreInitError);
			db = getFirestore(appInstance);
		}
		provider = new GoogleAuthProvider();

		onAuthStateChanged(auth, async (user) => {
			if (user) {
				currentUser = user;
				loadLocalState();
				updateUI();
				const shouldShowSyncFeedback = !user.isAnonymous && (isGoogleLoginInProgress || lastSyncedAuthUid !== user.uid);
				if (shouldShowSyncFeedback) {
					showToast("Login efetuado com sucesso, atualizando dados, aguarde", 2600);
				}
				updateProfileUI(user);
				try {
					await ensureLatestStateForUser(user);
					if (shouldShowSyncFeedback) {
						showToast("Dados atualizados com sucesso.", 2200);
					}
					lastSyncedAuthUid = user.uid;
				} catch (error) {
					console.error("Falha ao atualizar dados apos login:", error);
					if (shouldShowSyncFeedback) {
						showToast(
							isPermissionError(error)
								? "Sem permissao no Firestore. Ajuste as regras do banco."
								: isUnavailableError(error)
									? "Sem conexao com a nuvem agora. Modo offline ativo."
									: "Falha ao atualizar dados da nuvem.",
							3200
						);
					}
					if (isUnavailableError(error)) pendingCloudSync = true;
				} finally {
					if (!user.isAnonymous) isGoogleLoginInProgress = false;
				}
				if (pendingCloudSync) {
					startCloudRecoveryScheduler();
				} else {
					listenToCloud(user);
					stopCloudRecoveryScheduler();
				}
				console.log("Usuario detectado:", user.uid);
			} else {
				isGoogleLoginInProgress = false;
				lastSyncedAuthUid = null;
				currentUser = null;
				pendingCloudSync = false;
				stopCloudRecoveryScheduler();
				resetUI();
			}
		});
	} catch (e) {
		console.warn("Erro na inicializacao/Modo Offline: " + e.message);
	}
};

function resetUI(clearLocalData = false) {
	if (firestoreUnsubscribe) {
		firestoreUnsubscribe();
		firestoreUnsubscribe = null;
	}

	state = {
		...createInitialState(),
		currentTipIndex: state.currentTipIndex
	};
	if (clearLocalData) {
		try {
			localStorage.removeItem(LOCAL_STATE_KEY);
		} catch (e) {
			console.warn("Falha ao limpar estado local:", e?.message || e);
		}
	}
	updateUI();
	updateNavButtons(state.activeTab);

	const nameEl = document.getElementById("user-name-display");
	if (nameEl) nameEl.innerText = "Visitante";
	const uidEl = document.getElementById("user-uid-display");
	if (uidEl) uidEl.innerText = "...";
	const avatar = document.getElementById("user-avatar");
	if (avatar) avatar.innerText = "U";
	const badge = document.getElementById("auth-status-badge");
	if (badge) {
		badge.innerText = "OFFLINE";
		badge.className = "px-2 py-0.5 bg-slate-700 text-white text-[8px] font-black rounded-md";
	}
	const gBtn = document.getElementById("google-login-btn");
	if (gBtn) gBtn.classList.remove("hidden");
	const lBtn = document.getElementById("logout-btn");
	if (lBtn) lBtn.classList.add("hidden");
}

function updateProfileUI(user) {
	const uidEl = document.getElementById("user-uid-display");
	if (uidEl) uidEl.innerText = user.uid;

	const nameEl = document.getElementById("user-name-display");
	if (nameEl) nameEl.innerText = user.displayName || "Usuario Local";

	const badge = document.getElementById("auth-status-badge");
	if (badge) {
		const isAnon = user.isAnonymous;
		badge.innerText = isAnon ? "LOCAL" : "CONECTADO";
		badge.className = isAnon
			? "px-2 py-0.5 bg-slate-700 text-white text-[8px] font-black rounded-md"
			: "px-2 py-0.5 bg-emerald-600 text-white text-[8px] font-black rounded-md";
	}

	const avatar = document.getElementById("user-avatar");
	if (avatar) {
		if (user.photoURL) {
			avatar.innerHTML = `<img src="${user.photoURL}" class="w-full h-full object-cover rounded-full">`;
		} else {
			avatar.innerText = (user.displayName || "U")[0];
		}
	}

	const gBtn = document.getElementById("google-login-btn");
	if (gBtn) gBtn.classList.toggle("hidden", !user.isAnonymous && !user.isGuest);

	const lBtn = document.getElementById("logout-btn");
	if (lBtn) lBtn.classList.toggle("hidden", false);
}

async function syncToCloud() {
	ensureStateConsistency();
	saveLocalState();
	if (!currentUser || !db) return;
	try {
		const payload = { ...state, lastUpdated: nowIso() };
		console.log("[SyncToCloud] Salvando dados:", { totalIn: state.totalIn, totalOut: state.totalOut, transactions: state.transactions.length });
		await setDocToBothPaths(currentUser, payload);
		console.log("[SyncToCloud] Sucesso");
		pendingCloudSync = false;

		const icon = document.getElementById("sync-icon");
		if (icon) {
			icon.classList.replace("opacity-30", "opacity-100");
			setTimeout(() => icon.classList.replace("opacity-100", "opacity-30"), 1000);
		}
	} catch (e) {
		console.error("Erro ao sincronizar:", e);
		if (isPermissionError(e)) showToast("Nao foi possivel salvar na nuvem: permissao negada.", 3200);
		if (isUnavailableError(e)) {
			pendingCloudSync = true;
			startCloudRecoveryScheduler();
			showToast("Sem conexao com a nuvem. Vamos sincronizar quando voltar.", 3200);
		}
	}
}

function listenToCloud(user) {
	if (!db) return;
	if (firestoreUnsubscribe) firestoreUnsubscribe();

	const userDoc = getUserDocRef(user);
	firestoreUnsubscribe = onSnapshot(userDoc, (docSnap) => {
		if (docSnap.exists()) {
			const cloud = docSnap.data() || {};
			const cloudTs = toTimestampMs(cloud.lastUpdated);
			const localTs = toTimestampMs(state.lastUpdated);

			if (cloudTs < localTs && hasMeaningfulData(state)) {
				return;
			}

			mergeCloudIntoState(cloud);
			saveLocalState();
			if (typeof updateUI === "function") updateUI();
			if (typeof updateNavButtons === "function") updateNavButtons(state.activeTab);
		}
	}, (error) => {
		console.error("Erro no Snapshot:", error);
		if (isPermissionError(error)) showToast("Sem permissao para ler dados da nuvem.", 3200);
	});
}

// --- UI ---
const formatCurrency = (val) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val);
const playSound = (id) => {
	if (!isSoundEnabled) return;
	const el = document.getElementById(id);
	if (el) {
		el.currentTime = 0;
		el.play().catch(() => {});
	}
};
let toastTimer;

function saveSoundPreference() {
	try {
		localStorage.setItem(SOUND_ENABLED_KEY, isSoundEnabled ? "1" : "0");
	} catch (e) {
		console.warn("Falha ao salvar preferencia de som:", e?.message || e);
	}
}

function applySoundStateToAudioElements() {
	const audioEls = document.querySelectorAll("audio");
	audioEls.forEach((el) => {
		el.muted = !isSoundEnabled;
		if (!isSoundEnabled) {
			el.pause();
			el.currentTime = 0;
		}
	});
}

function updateSoundToggleButtonUI() {
	const btn = document.getElementById("sound-toggle-btn");
	if (!btn) return;
	const iconName = isSoundEnabled ? "bell" : "bell-off";

	btn.classList.toggle("opacity-30", !isSoundEnabled);
	btn.classList.toggle("opacity-100", isSoundEnabled);
	btn.setAttribute("aria-pressed", isSoundEnabled ? "true" : "false");
	btn.setAttribute("title", isSoundEnabled ? "Sons ativados" : "Sons desativados");
	btn.setAttribute("aria-label", isSoundEnabled ? "Desativar sons" : "Ativar sons");

	const currentIcon = btn.querySelector("i[data-lucide]")?.getAttribute("data-lucide");
	if (currentIcon !== iconName) {
		btn.innerHTML = `<i data-lucide="${iconName}" class="w-5 h-5 text-white"></i>`;
		if (window.lucide?.createIcons) window.lucide.createIcons();
	}
}

function loadSoundPreference() {
	try {
		const raw = localStorage.getItem(SOUND_ENABLED_KEY);
		if (raw === "0") isSoundEnabled = false;
		if (raw === "1") isSoundEnabled = true;
	} catch (e) {
		console.warn("Falha ao carregar preferencia de som:", e?.message || e);
	}

	applySoundStateToAudioElements();
	updateSoundToggleButtonUI();
}

function showToast(message, timeoutMs = 2200) {
	const toast = document.getElementById("custom-toast");
	const text = document.getElementById("toast-text");
	if (!toast || !text) return;

	text.innerText = message;
	toast.classList.remove("hidden");

	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toast.classList.add("hidden");
	}, timeoutMs);
}

window.toggleSound = () => {
	isSoundEnabled = !isSoundEnabled;
	saveSoundPreference();
	applySoundStateToAudioElements();
	updateSoundToggleButtonUI();
	showToast(isSoundEnabled ? "Sons ativados." : "Sons desativados.", 1500);
};

function setInputInvalid(el, isInvalid) {
	if (!el) return;
	el.classList.toggle("input-invalid", Boolean(isInvalid));
}

function cloneStateSnapshot() {
	return JSON.parse(JSON.stringify(state));
}

function parseBrDate(dateStr) {
	if (!dateStr || typeof dateStr !== "string") return null;
	const [d, m, y] = dateStr.split("/").map((v) => parseInt(v, 10));
	if (!d || !m || !y) return null;
	return new Date(y, m - 1, d);
}

function calculateTotalsFromState() {
	const totals = { totalIn: 0, totalOut: 0, totalSaved: 0 };
	state.transactions.forEach((t) => {
		const amount = Number(t.amount || 0);
		if (t.type === "income") totals.totalIn += amount;
		if (t.type === "expense") totals.totalOut += amount;
	});
	state.piggyBanks.forEach((p) => {
		totals.totalSaved += Number(p.current || 0);
	});
	return totals;
}

function ensureStateConsistency() {
	const calculated = calculateTotalsFromState();
	const epsilon = 0.001;
	const hasMismatch =
		Math.abs(Number(state.totalIn || 0) - calculated.totalIn) > epsilon ||
		Math.abs(Number(state.totalOut || 0) - calculated.totalOut) > epsilon ||
		Math.abs(Number(state.totalSaved || 0) - calculated.totalSaved) > epsilon;

	if (!hasMismatch) return;

	console.warn("[Consistency] Totais ajustados para manter integridade.", {
		before: { totalIn: state.totalIn, totalOut: state.totalOut, totalSaved: state.totalSaved },
		after: calculated
	});

	state.totalIn = calculated.totalIn;
	state.totalOut = calculated.totalOut;
	state.totalSaved = calculated.totalSaved;
	state.lastUpdated = nowIso();
}

function showUndoToast(message) {
	const toast = document.getElementById("undo-toast");
	const text = document.getElementById("undo-toast-text");
	if (!toast || !text) return;

	text.innerText = message;
	toast.classList.remove("hidden");

	if (undoTimer) clearTimeout(undoTimer);
	undoTimer = setTimeout(() => {
		pendingUndoSnapshot = null;
		toast.classList.add("hidden");
	}, UNDO_WINDOW_MS);
}

function registerUndoSnapshot(message) {
	pendingUndoSnapshot = {
		state: cloneStateSnapshot(),
		message
	};
	showUndoToast(message);
}

window.undoLastDeletion = async () => {
	if (!pendingUndoSnapshot?.state) return;
	state = pendingUndoSnapshot.state;
	state.lastUpdated = nowIso();
	pendingUndoSnapshot = null;
	const toast = document.getElementById("undo-toast");
	if (toast) toast.classList.add("hidden");
	if (undoTimer) clearTimeout(undoTimer);

	updateUI();
	await syncToCloud();
	showToast("Exclusao desfeita com sucesso.", 2000);
};

function getPiggySuggestion(piggy) {
	const remaining = Math.max(0, Number(piggy.target || 0) - Number(piggy.current || 0));
	if (remaining <= 0) return "Meta concluida! Hora de definir um novo sonho.";
	const weeklySuggestion = Math.max(10, Math.ceil(remaining / 8));
	const weeks = Math.max(1, Math.ceil(remaining / weeklySuggestion));
	return `Sugestao: guardando ${formatCurrency(weeklySuggestion)}/semana, conclui em ${weeks} semana${weeks > 1 ? "s" : ""}.`;
}

function getHistoryFilteredTransactions() {
	const typeValue = document.getElementById("history-filter-type")?.value || "all";
	const categoryValue = document.getElementById("history-filter-category")?.value || "all";
	const periodValue = document.getElementById("history-filter-period")?.value || "all";

	const now = new Date();
	return state.transactions.filter((t) => {
		if (typeValue !== "all" && t.type !== typeValue) return false;
		if (categoryValue !== "all" && t.subtype !== categoryValue) return false;
		if (periodValue === "all") return true;
		const txDate = parseBrDate(t.date);
		if (!txDate) return true;
		const daysDiff = Math.floor((now.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24));
		return daysDiff <= Number(periodValue);
	});
}

function populateHistoryCategoryFilter() {
	const typeValue = document.getElementById("history-filter-type")?.value || "all";
	const categorySelect = document.getElementById("history-filter-category");
	if (!categorySelect) return;

	const currentValue = categorySelect.value || "all";
	const categorySet = new Set();
	state.transactions.forEach((t) => {
		if (typeValue === "all" || t.type === typeValue) {
			if (t.subtype) categorySet.add(t.subtype);
		}
	});

	const options = ["<option value=\"all\">Categorias</option>", ...Array.from(categorySet).sort().map((cat) => `<option value=\"${cat}\">${cat}</option>`)].join("");
	categorySelect.innerHTML = options;
	if (categorySet.has(currentValue)) categorySelect.value = currentValue;
}

window.renderHistoryList = () => {
	populateHistoryCategoryFilter();
	const historyList = document.getElementById("history-list");
	if (!historyList) return;

	const filtered = getHistoryFilteredTransactions();
	if (filtered.length === 0) {
		historyList.innerHTML = `<p class=\"text-center py-10 opacity-20 text-xs font-black uppercase tracking-widest text-white\">Sem registros para este filtro</p>`;
		return;
	}

	historyList.innerHTML = filtered.map((t) => {
		const isIncome = t.type === "income";
		const isSaving = t.type === "saving";
		const toneClass = isIncome ? "bg-emerald-500/10 text-emerald-500" : isSaving ? "bg-indigo-500/10 text-indigo-400" : "bg-red-500/10 text-red-500";
		const valueClass = isIncome ? "text-emerald-500" : isSaving ? "text-indigo-400" : "text-red-500";
		const iconName = isIncome ? "trending-up" : isSaving ? "piggy-bank" : "trending-down";
		return `<div class=\"p-4 rounded-2xl border border-white/5 bg-white/[0.03] text-white\"><div class=\"flex justify-between items-center\"><div class=\"flex items-center gap-3\"><div class=\"p-3 rounded-xl ${toneClass}\"><i data-lucide=\"${iconName}\" class=\"w-4 h-4\"></i></div><div><p class=\"text-xs font-black uppercase tracking-tight\">${t.description}</p><p class=\"text-[9px] opacity-40 font-black uppercase\">${t.subtype} • ${t.date}</p></div></div><span class=\"font-black text-sm ${valueClass}\">${formatCurrency(t.amount)}</span></div></div>`;
	}).join("");
	lucide.createIcons();
};

window.openHistoryModal = () => {
	const modal = document.getElementById("history-modal");
	if (!modal) return;
	modal.classList.remove("hidden");
	window.renderHistoryList();
	lucide.createIcons();
};

window.closeHistoryModal = () => {
	const modal = document.getElementById("history-modal");
	if (!modal) return;
	modal.classList.add("hidden");
};

function launchConfetti(durationMs = 3800) {
	const container = document.getElementById("confetti-container");
	if (!container) return;
	container.innerHTML = "";

	const colors = ["#f59e0b", "#22c55e", "#3b82f6", "#ef4444", "#eab308", "#a855f7"];
	const particles = 78;

	for (let i = 0; i < particles; i++) {
		const piece = document.createElement("span");
		const x = Math.random() * 100;
		const drift = (Math.random() * 160 - 80).toFixed(2);
		const delay = (Math.random() * 0.8).toFixed(2);
		const size = 8 + Math.random() * 9;
		const rotate = (Math.random() * 720 - 360).toFixed(1);

		piece.className = "confetti";
		piece.style.left = `${x}%`;
		piece.style.top = "-10px";
		piece.style.width = `${size}px`;
		piece.style.height = `${size * 1.6}px`;
		piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
		piece.style.animationDelay = `${delay}s`;
		piece.style.setProperty("--drift", `${drift}px`);
		piece.style.setProperty("--rotate", `${rotate}deg`);
		container.appendChild(piece);
	}

	setTimeout(() => {
		container.innerHTML = "";
	}, durationMs);
}

function handlePiggyCompletion(piggy, previousAmount) {
	if (!piggy) return;
	if (previousAmount < piggy.target && piggy.current >= piggy.target && !celebratedPiggyIds.has(piggy.id)) {
		celebratedPiggyIds.add(piggy.id);
		playSound("audio-celeb");
		launchConfetti();
		showToast(`Parabens! Voce concluiu o cofrinho ${piggy.name}!`, 2800);
	}
}

function applyTransactionDelta(type, delta) {
	if (type === "income") state.totalIn = Math.max(0, state.totalIn + delta);
	if (type === "expense") state.totalOut = Math.max(0, state.totalOut + delta);
	if (type === "saving") state.totalSaved = Math.max(0, state.totalSaved + delta);
}

function findPiggyFromLegacyDescription(transaction) {
	if (!transaction?.description?.startsWith("Cofrinho: ")) return null;
	const piggyName = transaction.description.replace("Cofrinho: ", "").trim();
	return state.piggyBanks.find((p) => p.name === piggyName) || null;
}

function adjustPiggyFromSavingTransaction(transaction, deltaAmount) {
	if (!transaction || transaction.type !== "saving") return;
	const piggy = state.piggyBanks.find((p) => p.id === transaction.piggyId) || findPiggyFromLegacyDescription(transaction);
	if (!piggy) return;
	piggy.current = Math.max(0, piggy.current + deltaAmount);
}

function openDeleteModal() {
	const modal = document.getElementById("delete-modal");
	const sheet = modal?.firstElementChild;
	if (!modal || !sheet) return;

	modal.classList.remove("hidden", "modal-overlay-leave");
	sheet.classList.remove("modal-sheet-leave");
	modal.classList.add("modal-overlay-enter");
	sheet.classList.add("modal-sheet-enter");
}

function hideDeleteModal() {
	const modal = document.getElementById("delete-modal");
	const sheet = modal?.firstElementChild;
	if (!modal || !sheet) return;

	modal.classList.remove("modal-overlay-enter");
	sheet.classList.remove("modal-sheet-enter");
	modal.classList.add("modal-overlay-leave");
	sheet.classList.add("modal-sheet-leave");

	setTimeout(() => {
		modal.classList.add("hidden");
		modal.classList.remove("modal-overlay-leave");
		sheet.classList.remove("modal-sheet-leave");
	}, DELETE_MODAL_ANIMATION_MS);
}

function openEditModal() {
	const modal = document.getElementById("edit-modal");
	const sheet = modal?.firstElementChild;
	if (!modal || !sheet) return;

	modal.classList.remove("hidden", "modal-overlay-leave");
	sheet.classList.remove("modal-sheet-leave");
	modal.classList.add("modal-overlay-enter");
	sheet.classList.add("modal-sheet-enter");
}

function hideEditModal() {
	const modal = document.getElementById("edit-modal");
	const sheet = modal?.firstElementChild;
	if (!modal || !sheet) return;

	modal.classList.remove("modal-overlay-enter");
	sheet.classList.remove("modal-sheet-enter");
	modal.classList.add("modal-overlay-leave");
	sheet.classList.add("modal-sheet-leave");

	setTimeout(() => {
		modal.classList.add("hidden");
		modal.classList.remove("modal-overlay-leave");
		sheet.classList.remove("modal-sheet-leave");
	}, EDIT_MODAL_ANIMATION_MS);
}

function updateUI() {
	ensureStateConsistency();
	celebratedPiggyIds = new Set(state.piggyBanks.filter((p) => p.current >= p.target).map((p) => p.id));
	const balance = state.totalIn - state.totalOut - state.totalSaved;
	const balanceEl = document.getElementById("balance-display");
	if (balanceEl) {
		balanceEl.innerText = formatCurrency(balance);
		balanceEl.className = `text-4xl font-black tracking-tighter ${balance >= 0 ? "text-emerald-500" : "text-red-500"}`;
	}
	const inEl = document.getElementById("total-in-display");
	if (inEl) inEl.innerText = formatCurrency(state.totalIn);
	const outEl = document.getElementById("total-out-display");
	if (outEl) outEl.innerText = formatCurrency(state.totalOut);
	const savedEl = document.getElementById("total-saved-display");
	if (savedEl) savedEl.innerText = formatCurrency(state.totalSaved);
	const healthEl = document.getElementById("health-warning");
	if (healthEl) healthEl.style.display = (state.totalOut > state.totalIn && state.totalIn > 0) ? "block" : "none";
	const levelEl = document.getElementById("level-display");
	if (levelEl) levelEl.innerText = `Nivel ${state.userStats.level}`;
	const xpEl = document.getElementById("xp-bar");
	if (xpEl) xpEl.style.width = (state.userStats.xp % 100) + "%";

	const tipEl = document.getElementById("random-tip");
	if (tipEl) {
		tipEl.innerHTML = `${SAVING_TIPS[state.currentTipIndex]} <br><span class="text-indigo-400 text-[9px] font-black uppercase mt-1 inline-block border-b border-indigo-400">Saber mais ✨</span>`;
	}

	if (state.activeTab === "home") {
		const list = document.getElementById("transactions-list");
		if (list) {
			list.innerHTML = state.transactions.length === 0 ? `<p class="text-center py-10 opacity-20 text-xs font-black uppercase tracking-widest text-white">Sem registros</p>` :
				state.transactions.slice(0, 10).map(t => {
					const isIncome = t.type === "income";
					const isSaving = t.type === "saving";
					const toneClass = isIncome ? "bg-emerald-500/10 text-emerald-500" : isSaving ? "bg-indigo-500/10 text-indigo-400" : "bg-red-500/10 text-red-500";
					const valueClass = isIncome ? "text-emerald-500" : isSaving ? "text-indigo-400" : "text-red-500";
					const iconName = isIncome ? "trending-up" : isSaving ? "piggy-bank" : "trending-down";
					return `<div class="p-5 rounded-[30px] border border-white/5 bg-white/[0.03] text-white"><div class="flex justify-between items-center"><div class="flex items-center gap-4"><div class="p-3.5 rounded-2xl ${toneClass}"><i data-lucide="${iconName}"></i></div><div><p class="text-sm font-black uppercase tracking-tighter text-white">${t.description}</p><p class="text-[9px] opacity-30 font-black uppercase text-white">${t.subtype}</p></div></div><span class="font-black ${valueClass}">${formatCurrency(t.amount)}</span></div><div class="flex justify-end gap-2 mt-3"><button onclick="window.editTransaction(${t.id})" class="px-3 py-2 text-[9px] font-black uppercase rounded-xl bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 active:scale-95">Editar</button><button onclick="window.deleteTransaction(${t.id})" class="px-3 py-2 text-[9px] font-black uppercase rounded-xl bg-red-500/15 text-red-400 border border-red-500/30 active:scale-95">Remover</button></div></div>`;
				}).join("");
		}
	}

	if (state.activeTab === "status") {
		const chartContainer = document.getElementById("chart-container");
		if (chartContainer) {
			const max = Math.max(state.totalIn, state.totalOut, state.totalSaved, 1);
			chartContainer.innerHTML = [{ l: "Renda", v: state.totalIn, c: "bg-emerald-500" }, { l: "Gasto", v: state.totalOut, c: "bg-red-500" }, { l: "Reserva", v: state.totalSaved, c: "bg-indigo-500" }].map(item => `<div class="flex-1 flex flex-col items-center"><div class="relative w-full h-48 flex items-end"><div class="w-full ${item.c} rounded-t-2xl shadow-lg transition-all duration-1000" style="height: ${(item.v / max) * 100}%"></div></div><div class="mt-4 flex flex-col items-center text-center"><span class="text-[9px] font-black opacity-80 leading-none text-white">${formatCurrency(item.v)}</span><span class="text-[8px] font-black uppercase opacity-40 mt-1 text-white">${item.l}</span></div></div>`).join("");
		}
		const bList = document.getElementById("budgets-list");
		if (bList) {
			const catSpend = {};
			state.transactions.filter(t => t.type === "expense").forEach(t => catSpend[t.subtype] = (catSpend[t.subtype] || 0) + t.amount);
			bList.innerHTML = EXPENSE_SUBTYPES.map(cat => {
				const spend = catSpend[cat.name] || 0;
				const limit = state.budgets[cat.name] || 0;
				const perc = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0;
				return limit <= 0 ? "" : `<div class="p-6 rounded-[35px] border border-white/5 bg-white/[0.02] text-white"><div class="flex justify-between items-center mb-3"><div class="flex items-center gap-3"><div class="p-2.5 bg-white/5 rounded-xl"><i data-lucide="${cat.icon}" class="w-4 h-4 text-white"></i></div><span class="text-xs font-black uppercase text-white">${cat.name}</span></div><span class="text-[10px] font-black opacity-40 text-white">${formatCurrency(spend)} / ${formatCurrency(limit)}</span></div><div class="w-full h-2 bg-black/20 rounded-full overflow-hidden"><div class="h-full ${perc > 90 ? "bg-red-500" : perc > 70 ? "bg-yellow-500" : "bg-emerald-500"}" style="width: ${perc}%"></div></div></div>`;
			}).join("");
		}
	}

	if (state.activeTab === "piggy") {
		const pList = document.getElementById("piggies-list");
		if (pList) {
			pList.innerHTML = state.piggyBanks.map(p => {
				const perc = (p.current / p.target) * 100;
				const isCompleted = p.current >= p.target;
				const cardTone = isCompleted
					? "border-emerald-400/35 bg-emerald-500/10"
					: "border-white/10 bg-white/[0.03]";
				const suggestionTone = isCompleted ? "text-emerald-100/90" : "text-white";
				return `<div class="p-8 rounded-[45px] border ${cardTone} ${isCompleted ? "piggy-complete-glow" : ""} relative overflow-hidden text-white transition-colors duration-500"><div class="flex items-center gap-4 mb-6"><div class="p-4 rounded-2xl" style="background-color: ${p.color}20; color: ${p.color}"><i data-lucide="piggy-bank"></i></div><div><h4 class="font-black text-lg uppercase tracking-tighter text-white">${p.name}</h4><p class="text-[9px] font-black opacity-30 uppercase text-white">Meta: ${formatCurrency(p.target)}</p></div></div><div class="h-5 w-full bg-black/30 rounded-full overflow-hidden mb-3 p-1 border border-white/5 shadow-inner"><div class="h-full rounded-full" style="background-color: ${p.color}; width: ${Math.min(100, perc)}%"></div></div><div class="flex justify-between text-[10px] font-black mb-2 px-1"><span style="color: ${p.color}">${perc.toFixed(1)}%</span><span class="opacity-40 text-white">${formatCurrency(p.current)} acumulados</span></div><p class="text-[10px] font-bold opacity-70 mb-4 leading-relaxed ${suggestionTone}">${getPiggySuggestion(p)}</p><div class="flex justify-end gap-2 mb-4"><button onclick="window.editPiggy(${p.id})" class="px-3 py-2 text-[9px] font-black uppercase rounded-xl bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 active:scale-95">Editar</button><button onclick="window.deletePiggy(${p.id})" class="px-3 py-2 text-[9px] font-black uppercase rounded-xl bg-red-500/15 text-red-400 border border-red-500/30 active:scale-95">Remover</button></div><div class="flex gap-3 p-2 bg-black/20 rounded-[25px] border border-white/5"><input type="number" id="dep-input-${p.id}" placeholder="Quantia..." class="flex-1 bg-transparent px-4 outline-none font-black text-xs text-white" /><button onclick="window.depositPiggy(${p.id})" class="bg-indigo-600 px-6 py-4 rounded-[18px] font-black text-[9px] uppercase tracking-widest active:scale-95 text-white">Guardar</button></div>${isCompleted ? `<div class="absolute top-4 right-4 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest">Concluido</div>` : ""}</div>`;
			}).join("");
		}
	}
	const bInputs = document.getElementById("budget-inputs");
	if (bInputs) {
		bInputs.innerHTML = EXPENSE_SUBTYPES.map(cat => `<div class="flex items-center gap-4 p-4 rounded-[30px] bg-white/[0.03] border border-white/5 text-white"><div class="p-3 bg-white/5 rounded-2xl"><i data-lucide="${cat.icon}" class="opacity-60 text-white"></i></div><div class="flex-1"><p class="text-[10px] font-black uppercase ml-1 text-white">${cat.name}</p><div class="flex items-center gap-2"><span class="text-xs font-black opacity-30 text-white">R$</span><input type="number" onchange="window.updateBudget('${cat.name}', this.value)" value="${state.budgets[cat.name] || 0}" class="w-full bg-transparent outline-none font-black text-xl text-white" /></div></div></div>`).join("");
	}
	const historyModal = document.getElementById("history-modal");
	if (historyModal && !historyModal.classList.contains("hidden")) {
		window.renderHistoryList();
	}
	lucide.createIcons();
}

function updateNavButtons(activeId) {
	["home", "status", "piggy", "settings"].forEach(tab => {
		const btn = document.getElementById("nav-" + tab);
		if (btn) {
			if (tab === activeId) { btn.classList.remove("opacity-30"); btn.classList.add("text-yellow-500"); }
			else { btn.classList.add("opacity-30"); btn.classList.remove("text-yellow-500"); }
		}
	});
}

// --- ACTIONS IA ---
window.openAIChat = () => {
	const overlay = document.getElementById("ai-chat-overlay");
	if (overlay) overlay.classList.add("show");
	const container = document.getElementById("ai-messages-container");
	if (container) {
		container.innerHTML = "";
		appendMsg("ai", "Oi, eu sou o Leo. Estou aqui para ajudar voce a controlar seus gastos e melhorar sua vida financeira.");
	}
};

window.closeAIChat = () => {
	const overlay = document.getElementById("ai-chat-overlay");
	if (overlay) overlay.classList.remove("show");
};

function appendMsg(sender, text, isLoading = false) {
	const container = document.getElementById("ai-messages-container");
	if (!container) return;
	const div = document.createElement("div");
	div.className = `p-4 rounded-[22px] max-w-[85%] text-xs font-bold leading-relaxed ${sender === "ai" ? "bg-indigo-500/20 ai-message border border-indigo-500/30 self-start text-white" : "bg-white/10 user-message self-end text-white"}`;
	div.innerHTML = `<p class="${isLoading ? "loading-dots" : ""}">${text}</p>`;
	container.appendChild(div);
	container.scrollTop = container.scrollHeight;
	return div;
}

window.sendChatAction = async () => {
	const input = document.getElementById("ai-user-input");
	if (!input) return;
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	appendMsg("user", text);
	const loading = appendMsg("ai", "Pensando...", true);

	try {
		const response = await fetch(BACKEND_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: text })
		});
		const result = await response.json();
		if (loading) loading.remove();
		appendMsg("ai", result.response || "IA indisponivel.");
	} catch (e) {
		if (loading) loading.remove();
		appendMsg("ai", "Erro ao conectar ao servidor backend.");
	}
};

// --- NAVEGACAO E MODAIS ---
window.switchTab = (tabId) => {
	state.activeTab = tabId;
	document.querySelectorAll(".tab-content").forEach(t => {
		t.classList.remove("active");
		t.style.display = "none";
	});
	const target = document.getElementById(tabId + "-tab");
	if (target) {
		target.style.display = "block";
		requestAnimationFrame(() => { target.classList.add("active"); });
	}
	updateNavButtons(tabId);
	updateUI();
};

window.toggleModal = (id) => {
	const m = document.getElementById(id);
	if (m) m.classList.toggle("hidden");
	if (id === "add-modal") window.setModalType(state.modalType);
};

window.setModalType = (type) => {
	const currentDesc = document.getElementById("form-desc")?.value || document.getElementById("form-piggy-name")?.value || "";
	const currentAmount = document.getElementById("form-amount")?.value || document.getElementById("form-piggy-target")?.value || "";

	if (state.modalType !== type) {
		if (type === "income") state.selectedSubtype = "Salario";
		else if (type === "expense") state.selectedSubtype = "Alimentacao";
	}
	state.modalType = type;

	const container = document.getElementById("modal-forms-container");
	if (!container) return;

	document.querySelectorAll(".modal-type-btn").forEach(b => {
		b.classList.add("opacity-40"); b.classList.remove("bg-yellow-500", "text-black", "shadow-lg");
	});
	const btn = document.getElementById(`btn-type-${type}`);
	if (btn) { btn.classList.remove("opacity-40"); btn.classList.add("bg-yellow-500", "text-black", "shadow-lg"); }

	if (type === "income" || type === "expense") {
		const list = type === "expense" ? EXPENSE_SUBTYPES : INCOME_SUBTYPES;
		container.innerHTML = `
			<div class="space-y-6">
				<input type="text" id="form-desc" value="${currentDesc}" placeholder="Descricao" class="w-full p-4 rounded-[25px] outline-none font-black text-sm bg-white/5 border border-white/5 text-white" />
				<div class="w-full">
					<input type="number" id="form-amount" value="${currentAmount}" placeholder="Valor R$" class="flex-1 p-4 rounded-[25px] outline-none font-black text-xl bg-white/5 border border-white/5 text-white w-full" />
				</div>
				<div class="space-y-3">
					<p class="text-[9px] font-black uppercase ml-1 text-white">Categoria</p>
					<div class="grid grid-cols-4 gap-2 py-1">
						${list.map(s => `<button onclick="window.selectSubtype('${s.name}', '${type}')" class="flex flex-col items-center justify-center p-2 rounded-[15px] border transition-all ${state.selectedSubtype === s.name ? "border-yellow-500 bg-yellow-500/20 text-yellow-500" : "border-white/5 bg-white/5 opacity-40 text-white"}"><i data-lucide="${s.icon}" class="w-4 h-4 mb-1"></i><span class="text-[7px] font-black uppercase text-center leading-tight truncate w-full text-white">${s.name}</span></button>`).join("")}
					</div>
				</div>
			</div>
		`;
	} else {
		container.innerHTML = `
			<div class="space-y-6">
				<input type="text" id="form-piggy-name" value="${currentDesc}" placeholder="Nome do Sonho" class="w-full p-5 rounded-[25px] outline-none font-black bg-white/5 border border-white/5 text-white" />
				<div class="flex gap-3">
					<input type="number" id="form-piggy-target" value="${currentAmount}" placeholder="Meta R$" class="flex-1 p-5 rounded-[25px] outline-none font-black bg-white/5 border border-white/5 text-white" />
					<input type="color" id="form-piggy-color" value="#f59e0b" class="w-16 h-14 p-2 rounded-[20px] cursor-pointer bg-transparent border-none shrink-0" />
				</div>
			</div>
		`;
	}
	lucide.createIcons();
};

window.selectSubtype = (name, type) => { state.selectedSubtype = name; window.setModalType(type); };

function getSubtypeListByType(type) {
	if (type === "expense") return EXPENSE_SUBTYPES;
	if (type === "income") return INCOME_SUBTYPES;
	return [];
}

function renderEditSubtypeSelector(type) {
	const grid = document.getElementById("edit-subtype-grid");
	if (!grid) return;
	const list = getSubtypeListByType(type);
	const selected = editContext?.selectedSubtype || "";

	grid.innerHTML = list.map((s) => `
		<button type="button" onclick="window.selectEditSubtype('${s.name}')" class="flex flex-col items-center justify-center p-2 rounded-[15px] border transition-all ${selected === s.name ? "border-yellow-500 bg-yellow-500/20 text-yellow-500" : "border-white/5 bg-white/5 opacity-40 text-white"}">
			<i data-lucide="${s.icon}" class="w-4 h-4 mb-1"></i>
			<span class="text-[7px] font-black uppercase text-center leading-tight truncate w-full text-white">${s.name}</span>
		</button>
	`).join("");

	lucide.createIcons();
}

window.selectEditSubtype = (name) => {
	if (!editContext || editContext.mode !== "transaction") return;
	editContext.selectedSubtype = name;
	const transaction = state.transactions.find((t) => t.id === editContext.id);
	if (!transaction) return;
	renderEditSubtypeSelector(transaction.type);
};

window.submitForm = async () => {
	const dEl = document.getElementById("form-desc") || document.getElementById("form-piggy-name");
	const aEl = document.getElementById("form-amount") || document.getElementById("form-piggy-target");
	const desc = dEl?.value?.trim();
	const amount = parseFloat(aEl?.value);

	if (state.modalType === "income" || state.modalType === "expense") {
		const invalidDesc = !desc;
		const invalidAmount = Number.isNaN(amount) || amount <= 0;
		setInputInvalid(dEl, invalidDesc);
		setInputInvalid(aEl, invalidAmount);
		if (invalidDesc || invalidAmount) {
			showToast("Preencha nome e valor validos.", 2200);
			return;
		}
		if (state.modalType === "income") { state.totalIn += amount; playSound("audio-money"); }
		else { state.totalOut += amount; }
		state.transactions.unshift({ id: Date.now(), description: desc, amount, type: state.modalType, subtype: state.selectedSubtype, date: new Date().toLocaleDateString("pt-BR") });
	} else {
		const invalidDesc = !desc;
		const invalidAmount = Number.isNaN(amount) || amount <= 0;
		setInputInvalid(dEl, invalidDesc);
		setInputInvalid(aEl, invalidAmount);
		if (invalidDesc || invalidAmount) {
			showToast("Preencha nome e meta validos.", 2200);
			return;
		}
		state.piggyBanks.push({ id: Date.now(), name: desc, target: amount, color: document.getElementById("form-piggy-color")?.value, current: 0 });
	}

	if (dEl) dEl.value = "";
	if (aEl) aEl.value = "";
	window.toggleModal("add-modal");
	state.userStats.xp += 10;
	state.userStats.level = Math.floor(state.userStats.xp / 100) + 1;
	updateUI();
	syncToCloud();
};

window.depositPiggy = async (id) => {
	const input = document.getElementById(`dep-input-${id}`);
	const val = parseFloat(input.value);
	const bal = state.totalIn - state.totalOut - state.totalSaved;
	const invalidValue = Number.isNaN(val) || val <= 0 || val > bal;
	setInputInvalid(input, invalidValue);
	if (invalidValue) {
		showToast("Informe um valor valido dentro do saldo disponivel.", 2200);
		return;
	}
	const p = state.piggyBanks.find(x => x.id === id);
	if (!p) return;
	const remainingToTarget = Math.max(0, Number(p.target || 0) - Number(p.current || 0));
	if (remainingToTarget <= 0) {
		showToast("Este cofrinho ja atingiu a meta.", 2200);
		if (input) input.value = "";
		return;
	}
	if (val > remainingToTarget) {
		setInputInvalid(input, true);
		showToast(`Valor acima do limite. Maximo permitido: ${formatCurrency(remainingToTarget)}.`, 2600);
		return;
	}
	setInputInvalid(input, false);
	const previousAmount = p.current;
	p.current += val; state.totalSaved += val;
	state.transactions.unshift({ id: Date.now(), description: `Cofrinho: ${p.name}`, amount: val, type: "saving", subtype: "Cofrinho", piggyId: p.id, date: new Date().toLocaleDateString("pt-BR") });
	playSound("audio-money");
	handlePiggyCompletion(p, previousAmount);
	if (input) input.value = "";
	updateUI();
	syncToCloud();
};

window.editTransaction = (id) => {
	const transaction = state.transactions.find((t) => t.id === id);
	if (!transaction) return;

	const subtypeList = getSubtypeListByType(transaction.type);
	const defaultSubtype = transaction.subtype || subtypeList[0]?.name || "";
	editContext = { mode: "transaction", id: transaction.id, selectedSubtype: defaultSubtype };
	const titleEl = document.getElementById("edit-modal-title");
	const subtitleEl = document.getElementById("edit-modal-subtitle");
	if (titleEl) titleEl.innerText = "Editar Registro";
	if (subtitleEl) subtitleEl.innerText = transaction.type === "saving" ? "Movimento do cofrinho" : "Atualize nome e valor";

	const form = document.getElementById("edit-modal-form");
	if (!form) return;

	const showSubtype = transaction.type === "income" || transaction.type === "expense";
	form.innerHTML = `
		<div class="space-y-6">
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Nome</p>
				<input type="text" id="edit-transaction-desc" value="${transaction.description}" class="w-full p-4 rounded-[25px] outline-none font-black text-sm bg-white/5 border border-white/10 text-white" />
			</div>
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Valor</p>
				<input type="number" id="edit-transaction-amount" value="${transaction.amount}" class="w-full p-4 rounded-[25px] outline-none font-black text-xl bg-white/5 border border-white/10 text-white" />
			</div>
			${showSubtype ? `<div class="space-y-3"><p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Categoria</p><div id="edit-subtype-grid" class="grid grid-cols-4 gap-2 py-1"></div></div>` : ""}
			<p class="text-[10px] font-black opacity-40 uppercase">Data original: ${transaction.date || "-"}</p>
		</div>
	`;

	openEditModal();
	if (showSubtype) renderEditSubtypeSelector(transaction.type);
	else lucide.createIcons();
};

window.deleteTransaction = async (id) => {
	const transaction = state.transactions.find((t) => t.id === id);
	if (!transaction) return;

	const titleEl = document.getElementById("delete-modal-title");
	const messageEl = document.getElementById("delete-modal-message");
	if (titleEl) titleEl.innerText = "Remover Registro";
	if (messageEl) messageEl.innerText = `Deseja remover o registro \"${transaction.description}\"?`;

	deleteContext = { type: "transaction", id: transaction.id };
	openDeleteModal();
};

async function executeDeleteTransaction(id) {
	const transaction = state.transactions.find((t) => t.id === id);
	if (!transaction) return;
	registerUndoSnapshot("Registro removido. Toque em desfazer para restaurar.");

	state.transactions = state.transactions.filter((t) => t.id !== id);
	applyTransactionDelta(transaction.type, -Number(transaction.amount || 0));
	adjustPiggyFromSavingTransaction(transaction, -Number(transaction.amount || 0));
	state.lastUpdated = nowIso();

	updateUI();
	await syncToCloud();
	showToast("Registro removido.", 1800);
}

window.editPiggy = (id) => {
	const piggy = state.piggyBanks.find((p) => p.id === id);
	if (!piggy) return;

	editContext = { mode: "piggy", id: piggy.id };
	const titleEl = document.getElementById("edit-modal-title");
	const subtitleEl = document.getElementById("edit-modal-subtitle");
	if (titleEl) titleEl.innerText = "Editar Cofrinho";
	if (subtitleEl) subtitleEl.innerText = "Atualize nome, valor e meta";

	const form = document.getElementById("edit-modal-form");
	if (!form) return;

	form.innerHTML = `
		<div class="space-y-6">
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Nome</p>
				<input type="text" id="edit-piggy-name" value="${piggy.name}" class="w-full p-4 rounded-[25px] outline-none font-black text-sm bg-white/5 border border-white/10 text-white" />
			</div>
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Valor Guardado</p>
				<input type="number" id="edit-piggy-current" value="${piggy.current}" class="w-full p-4 rounded-[25px] outline-none font-black text-xl bg-white/5 border border-white/10 text-white" />
			</div>
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Meta</p>
				<input type="number" id="edit-piggy-target" value="${piggy.target}" class="w-full p-4 rounded-[25px] outline-none font-black text-xl bg-white/5 border border-white/10 text-white" />
			</div>
			<div>
				<p class="text-[9px] font-black uppercase mb-2 opacity-50 tracking-widest">Cor</p>
				<input type="color" id="edit-piggy-color" value="${piggy.color || "#f59e0b"}" class="w-full h-14 p-2 rounded-[20px] cursor-pointer bg-white/5 border border-white/10" />
			</div>
		</div>
	`;

	openEditModal();
	lucide.createIcons();
};

window.deletePiggy = async (id) => {
	const piggy = state.piggyBanks.find((p) => p.id === id);
	if (!piggy) return;

	const titleEl = document.getElementById("delete-modal-title");
	const messageEl = document.getElementById("delete-modal-message");
	if (titleEl) titleEl.innerText = "Remover Cofrinho";
	if (messageEl) messageEl.innerText = `Deseja remover o cofrinho \"${piggy.name}\"?`;

	deleteContext = { type: "piggy", id: piggy.id };
	openDeleteModal();
};

async function executeDeletePiggy(id) {
	const piggy = state.piggyBanks.find((p) => p.id === id);
	if (!piggy) return;
	registerUndoSnapshot("Cofrinho removido. Toque em desfazer para restaurar.");

	state.totalSaved = Math.max(0, state.totalSaved - Number(piggy.current || 0));
	const piggyNameSnapshot = piggy.name;
	state.transactions = state.transactions.filter((t) => {
		if (t.type !== "saving") return true;
		if (t.piggyId === id) return false;
		if (typeof t.description === "string" && t.description.trim() === `Cofrinho: ${piggyNameSnapshot}`) return false;
		return true;
	});
	state.piggyBanks = state.piggyBanks.filter((p) => p.id !== id);
	celebratedPiggyIds.delete(id);
	state.lastUpdated = nowIso();

	updateUI();
	await syncToCloud();
	showToast("Cofrinho removido.", 1800);
}

window.updateBudget = (name, val) => { state.budgets[name] = parseFloat(val) || 0; updateUI(); syncToCloud(); };

window.closeEditModal = () => {
	hideEditModal();
	editContext = null;
};

window.closeDeleteModal = () => {
	hideDeleteModal();
	deleteContext = null;
};

window.confirmDeleteModal = async () => {
	if (!deleteContext?.type || !deleteContext?.id) return;

	if (deleteContext.type === "transaction") {
		await executeDeleteTransaction(deleteContext.id);
	}

	if (deleteContext.type === "piggy") {
		await executeDeletePiggy(deleteContext.id);
	}

	window.closeDeleteModal();
};

window.submitEditModal = async () => {
	if (!editContext?.mode) return;

	if (editContext.mode === "transaction") {
		const transaction = state.transactions.find((t) => t.id === editContext.id);
		if (!transaction) return;

		const desc = document.getElementById("edit-transaction-desc")?.value?.trim();
		const amount = parseFloat(document.getElementById("edit-transaction-amount")?.value || "");
		const selectedSubtype = editContext.selectedSubtype || transaction.subtype;

		if (!desc || Number.isNaN(amount) || amount <= 0) {
			setInputInvalid(document.getElementById("edit-transaction-desc"), !desc);
			setInputInvalid(document.getElementById("edit-transaction-amount"), Number.isNaN(amount) || amount <= 0);
			showToast("Preencha nome e valor validos.", 2200);
			return;
		}
		setInputInvalid(document.getElementById("edit-transaction-desc"), false);
		setInputInvalid(document.getElementById("edit-transaction-amount"), false);

		const delta = amount - Number(transaction.amount || 0);
		if (transaction.type === "saving") {
			const piggy = state.piggyBanks.find((p) => p.id === transaction.piggyId) || findPiggyFromLegacyDescription(transaction);
			if (piggy) {
				const projected = Number(piggy.current || 0) + delta;
				if (projected > Number(piggy.target || 0)) {
					showToast(`Edicao excede a meta do cofrinho (${formatCurrency(piggy.target)}).`, 2800);
					return;
				}
				if (projected < 0) {
					showToast("Valor invalido para este cofrinho.", 2200);
					return;
				}
			}
		}

		applyTransactionDelta(transaction.type, delta);
		adjustPiggyFromSavingTransaction(transaction, delta);

		transaction.description = desc;
		transaction.amount = amount;
		if (transaction.type === "income" || transaction.type === "expense") {
			transaction.subtype = selectedSubtype || transaction.subtype;
		}
		transaction.date = new Date().toLocaleDateString("pt-BR");
		state.lastUpdated = nowIso();

		updateUI();
		await syncToCloud();
		window.closeEditModal();
		showToast("Registro atualizado com sucesso.", 2200);
		return;
	}

	if (editContext.mode === "piggy") {
		const piggy = state.piggyBanks.find((p) => p.id === editContext.id);
		if (!piggy) return;

		const name = document.getElementById("edit-piggy-name")?.value?.trim();
		const current = parseFloat(document.getElementById("edit-piggy-current")?.value || "");
		const target = parseFloat(document.getElementById("edit-piggy-target")?.value || "");
		const color = document.getElementById("edit-piggy-color")?.value || piggy.color;

		if (!name) {
			setInputInvalid(document.getElementById("edit-piggy-name"), true);
			showToast("Informe o nome do cofrinho.", 2200);
			return;
		}
		setInputInvalid(document.getElementById("edit-piggy-name"), false);
		if (Number.isNaN(current) || current < 0) {
			setInputInvalid(document.getElementById("edit-piggy-current"), true);
			showToast("Valor guardado invalido.", 2200);
			return;
		}
		setInputInvalid(document.getElementById("edit-piggy-current"), false);
		if (Number.isNaN(target) || target <= 0) {
			setInputInvalid(document.getElementById("edit-piggy-target"), true);
			showToast("Meta invalida.", 2200);
			return;
		}
		setInputInvalid(document.getElementById("edit-piggy-target"), false);
		if (current > target) {
			setInputInvalid(document.getElementById("edit-piggy-current"), true);
			setInputInvalid(document.getElementById("edit-piggy-target"), true);
			showToast("Valor guardado nao pode ultrapassar a meta.", 2600);
			return;
		}
		setInputInvalid(document.getElementById("edit-piggy-current"), false);
		setInputInvalid(document.getElementById("edit-piggy-target"), false);

		const oldCurrent = Number(piggy.current || 0);
		piggy.name = name;
		piggy.current = current;
		piggy.target = target;
		piggy.color = color;
		state.totalSaved = Math.max(0, state.totalSaved - oldCurrent + current);
		state.lastUpdated = nowIso();

		if (piggy.current < piggy.target) celebratedPiggyIds.delete(piggy.id);
		if (piggy.current >= piggy.target) celebratedPiggyIds.add(piggy.id);

		updateUI();
		await syncToCloud();
		window.closeEditModal();
		showToast("Cofrinho atualizado.", 1800);
	}
};

// --- 3D ENGINE ---
function init3D() {
	const container = document.getElementById("coin-canvas-container");
	if (!container) return;

	const scene = new THREE.Scene();
	const width = container.clientWidth || 120;
	const height = container.clientHeight || 120;
	const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000);
	camera.position.set(0, 0, 10);

	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setSize(width, height);
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 2.4;
	container.appendChild(renderer.domElement);

	function createCoinTexture() {
		const canvas = document.createElement("canvas");
		canvas.width = 1024; canvas.height = 1024;
		const ctx = canvas.getContext("2d");

		const goldGrad = ctx.createRadialGradient(512, 512, 350, 512, 512, 512);
		goldGrad.addColorStop(0, "#ffd700"); goldGrad.addColorStop(1, "#c5a000");
		ctx.fillStyle = goldGrad; ctx.fillRect(0, 0, 1024, 1024);

		ctx.strokeStyle = "rgba(139, 101, 8, 0.3)"; ctx.lineWidth = 4;
		for (let i = -1024; i < 2048; i += 40) {
			ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 500, 1024); ctx.stroke();
		}

		ctx.save();
		ctx.beginPath(); ctx.arc(512, 512, 360, 0, Math.PI * 2); ctx.clip();
		const silverGrad = ctx.createRadialGradient(512, 512, 0, 512, 512, 400);
		silverGrad.addColorStop(0, "#ffffff"); silverGrad.addColorStop(0.7, "#e0e0e0"); silverGrad.addColorStop(1, "#a0a0a0");
		ctx.fillStyle = silverGrad; ctx.fillRect(0, 0, 1024, 1024);
		ctx.restore();

		ctx.save();
		ctx.translate(512, 512);
		ctx.rotate(-Math.PI / 2);
		ctx.textAlign = "center"; ctx.textBaseline = "middle";
		ctx.font = "bold 600px Arial";
		ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.fillText("$", 8, 8);
		ctx.fillStyle = "#666"; ctx.fillText("$", 0, 0);
		ctx.restore();

		const texture = new THREE.CanvasTexture(canvas);
		texture.anisotropy = 4;
		return texture;
	}

	const coinTexture = createCoinTexture();

	const goldMat = new THREE.MeshStandardMaterial({
		color: 0xffd700, metalness: 1.0, roughness: 0.15, emissive: 0x332200, emissiveIntensity: 0.2
	});
	const faceMat = new THREE.MeshStandardMaterial({
		map: coinTexture, metalness: 1.0, roughness: 0.12, bumpMap: coinTexture, bumpScale: 0.015
	});

	const coinGroup = new THREE.Group();
	const bodyGeom = new THREE.CylinderGeometry(2, 2, 0.25, 128);
	const coinBody = new THREE.Mesh(bodyGeom, [goldMat, faceMat, faceMat]);
	coinBody.rotation.x = Math.PI / 2;
	coinGroup.add(coinBody);

	const ringGeom = new THREE.TorusGeometry(1.98, 0.06, 24, 100);
	const ring1 = new THREE.Mesh(ringGeom, goldMat); ring1.position.z = 0.12; coinGroup.add(ring1);
	const ring2 = ring1.clone(); ring2.position.z = -0.12; coinGroup.add(ring2);

	scene.add(coinGroup);

	scene.add(new THREE.AmbientLight(0xffffff, 0.8));
	scene.add(new THREE.HemisphereLight(0xffffff, 0xffd700, 0.6));

	const fLight = new THREE.SpotLight(0xffffff, 4);
	fLight.position.set(0, 0, 15); fLight.target = coinGroup; scene.add(fLight);

	const bLight = new THREE.DirectionalLight(0xffffff, 3);
	bLight.position.set(0, 5, -15);
	scene.add(bLight);

	const lightsConfig = [
		{ x: -10, y: 5, z: 8, i: 3 }, { x: 10, y: 5, z: 8, i: 3 },
		{ x: -10, y: -5, z: 8, i: 3 }, { x: 10, y: -5, z: 8, i: 3 },
		{ x: -12, y: 0, z: 6, i: 5 }, { x: 12, y: 0, z: 6, i: 5 },
		{ x: -10, y: 0, z: -10, i: 4 }, { x: 10, y: 0, z: -10, i: 4 }
	];

	lightsConfig.forEach(l => {
		const s = new THREE.SpotLight(0xffffff, l.i);
		s.position.set(l.x, l.y, l.z);
		s.target = coinGroup;
		s.penumbra = 0.3;
		if (l.y === 0 && l.z > 0) { s.angle = Math.PI / 10; }
		scene.add(s);
	});

	function animate() {
		requestAnimationFrame(animate);
		coinGroup.rotation.y += 0.015;
		coinGroup.position.y = Math.sin(Date.now() * 0.002) * 0.15;
		renderer.render(scene, camera);
	}
	animate();
}

window.onload = async () => {
	loadLocalState();
	loadSoundPreference();
	state.currentTipIndex = Math.floor(Math.random() * SAVING_TIPS.length);
	init3D();
	await tryInitFirebase();
	updateUI();
	updateNavButtons(state.activeTab);
	lucide.createIcons();

	window.addEventListener("online", async () => {
		if (!currentUser) return;
		if (!pendingCloudSync) return;
		console.log("[SyncToCloud] Conexao restaurada. Tentando sincronizar pendencias...");
		await syncToCloud();
		if (!pendingCloudSync) {
			listenToCloud(currentUser);
			stopCloudRecoveryScheduler();
		}
	});
};

window.handleGoogleLogin = async () => {
	if (!auth) return;
	try {
		isGoogleLoginInProgress = true;
		await signInWithPopup(auth, provider);
	} catch (e) {
		isGoogleLoginInProgress = false;
		console.error("Falha no login Google:", e);
		showToast("Nao foi possivel conectar com Google.", 2600);
	}
};
window.handleLogout = async () => {
	if (!auth) return;
	try {
		saveLocalState();
		await signOut(auth);
		pendingCloudSync = false;
		stopCloudRecoveryScheduler();
		resetUI(false);
		showToast("Conta desconectada. Faça login para sincronizar dados.");
	} catch (e) {
		console.error("Falha ao sair da conta:", e);
		showToast("Erro ao sair da conta. Tente novamente.", 2600);
	}
};
