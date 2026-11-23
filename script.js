import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  increment,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

/* ==========================================================================
   CONFIGURACIÓN DE FIREBASE (PEGA AQUÍ LOS DATOS DE TU PROYECTO FIREBASE)
   ========================================================================== */
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};

// Dominio interno para convertir usuarios tipo "alexa_hd" a correo de Firebase Auth
const INTERNAL_DOMAIN = "@heavensdoors.internal";
// Correo/usuario designado como FOUNDER principal
const FOUNDER_USERNAME = "alexa_hd";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// App secundaria de Firebase para que Founder pueda crear cuentas de Admins
// sin cerrar su propia sesión activa
const secondaryApp = initializeApp(firebaseConfig, "SecondaryAdminCreator");
const secondaryAuth = getAuth(secondaryApp);

/* ==========================================================================
   ESTADO GLOBAL DE LA APLICACIÓN
   ========================================================================== */
let currentUser = null;
let currentProfile = null; // { uid, username, displayName, role: 'founder' | 'admin' }
let membersCache = [];
let schedulesCache = [];
let activitiesCache = [];
let inactivitiesCache = [];
let staffCache = [];
let monthlyArchivesCache = [];
let logsCache = [];

let selectedParticipants = []; // [{ id, uniqueId, alias, roblox, whatsapp, discord }]
let selectedEvidenceFiles = []; // File[]

const DAY_ORDER = {
  "Lunes": 1, "Martes": 2, "Miércoles": 3, "Jueves": 4,
  "Viernes": 5, "Sábado": 6, "Domingo": 7
};

/* ==========================================================================
   1. AUTENTICACIÓN Y ROLES (SIN REGISTRO PÚBLICO)
   ========================================================================== */
const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");

function formatAuthEmail(usernameInput) {
  const clean = usernameInput.trim().toLowerCase();
  return clean.includes("@") ? clean : `${clean}${INTERNAL_DOMAIN}`;
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  const username = document.getElementById("login-user").value;
  const password = document.getElementById("login-pass").value;

  try {
    await signInWithEmailAndPassword(auth, formatAuthEmail(username), password);
    loginForm.reset();
  } catch (err) {
    loginError.textContent = "Credenciales incorrectas o cuenta no autorizada.";
    loginError.classList.remove("hidden");
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    currentProfile = null;
    loginScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
    return;
  }

  currentUser = user;
  const staffRef = doc(db, "staff", user.uid);
  const staffSnap = await getDoc(staffRef);

  const rawUser = user.email.replace(INTERNAL_DOMAIN, "");
  const isFounderAccount = rawUser.toLowerCase() === FOUNDER_USERNAME.toLowerCase();

  if (!staffSnap.exists()) {
    // Si es la primera vez que entra Founder, crea su perfil maestro automáticamente
    const initialProfile = {
      uid: user.uid,
      username: rawUser,
      displayName: isFounderAccount ? "Alexa (Founder)" : rawUser,
      role: isFounderAccount ? "founder" : "admin",
      active: true,
      createdAt: serverTimestamp()
    };
    await setDoc(staffRef, initialProfile);
    currentProfile = initialProfile;
  } else {
    currentProfile = staffSnap.data();
  }

  applyRolePermissions();
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  initRealtimeListeners();
  updateAdminSheetPreview();
});

function applyRolePermissions() {
  const isFounder = currentProfile.role === "founder";
  document.getElementById("current-user-name").textContent = currentProfile.displayName;
  const rolePill = document.getElementById("current-user-role");
  rolePill.textContent = isFounder ? "FOUNDER" : "ADMIN";
  rolePill.classList.toggle("founder", isFounder);

  document.querySelectorAll(".founder-only").forEach((el) => {
    el.classList.toggle("hidden", !isFounder);
  });
}

/* ==========================================================================
   NAVEGACIÓN ENTRE PESTAÑAS Y MENÚ MÓVIL
   ========================================================================== */
const sidebar = document.getElementById("sidebar");
document.getElementById("menu-toggle").addEventListener("click", () => {
  sidebar.classList.toggle("open");
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".tab-view").forEach((view) => {
      view.classList.toggle("active", view.id === `tab-${target}`);
    });
    sidebar.classList.remove("open");
  });
});

/* ==========================================================================
   SINCRONIZACIÓN EN TIEMPO REAL CON FIRESTORE
   ========================================================================== */
function initRealtimeListeners() {
  // Integrantes (Fichas únicas)
  onSnapshot(collection(db, "members"), (snap) => {
    membersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMembersTable();
    renderPointsTable();
    renderMonthlyPodium();
    renderDashboard();
  });

  // Horario Semanal
  onSnapshot(collection(db, "schedules"), (snap) => {
    schedulesCache = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (DAY_ORDER[a.day] || 9) - (DAY_ORDER[b.day] || 9) || a.time.localeCompare(b.time));
    renderScheduleTable();
    renderDashboard();
  });

  // Actividades y Aprobaciones
  onSnapshot(query(collection(db, "activities"), orderBy("createdAt", "desc")), (snap) => {
    activitiesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderApprovals();
    renderHistory();
    renderDashboard();
  });

  // Inactividades
  onSnapshot(query(collection(db, "inactivities"), orderBy("createdAt", "desc")), (snap) => {
    inactivitiesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderInactivities();
    renderDashboard();
  });

  // Personal / Staff
  onSnapshot(collection(db, "staff"), (snap) => {
    staffCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderStaffList();
    renderDashboard();
  });

  // Cierres Mensuales
  onSnapshot(query(collection(db, "monthly_archives"), orderBy("closedAt", "desc")), (snap) => {
    monthlyArchivesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMonthlyArchives();
  });

  // Auditoría / Cambios
  onSnapshot(query(collection(db, "logs"), orderBy("timestamp", "desc")), (snap) => {
    logsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHistory();
  });
}

async function registerSystemLog(actionText) {
  await addDoc(collection(db, "logs"), {
    action: actionText,
    by: currentProfile.displayName,
    timestamp: serverTimestamp()
  });
}

/* ==========================================================================
   2. HORARIO SEMANAL
   ========================================================================== */
const slotEditorCard = document.getElementById("slot-editor-card");
const slotForm = document.getElementById("slot-form");

document.getElementById("btn-open-slot-modal").addEventListener("click", () => {
  slotForm.reset();
  document.getElementById("slot-id").value = "";
  document.getElementById("slot-form-title").textContent = "Nuevo Espacio en Horario";
  slotEditorCard.classList.remove("hidden");
});

document.getElementById("btn-cancel-slot").addEventListener("click", () => {
  slotEditorCard.classList.add("hidden");
});

slotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile.role !== "founder") return;

  const slotId = document.getElementById("slot-id").value;
  const adminAssigned = document.getElementById("slot-admin").value.trim();
  const payload = {
    day: document.getElementById("slot-day").value,
    time: document.getElementById("slot-time").value.trim(),
    activity: document.getElementById("slot-activity").value.trim(),
    assignedAdmin: adminAssigned,
    assignedUid: "",
    status: adminAssigned ? "Ocupado" : "Disponible"
  };

  if (slotId) {
    await updateDoc(doc(db, "schedules", slotId), payload);
    await registerSystemLog(`Modificó horario: ${payload.day} ${payload.time} (${payload.activity})`);
  } else {
    await addDoc(collection(db, "schedules"), payload);
    await registerSystemLog(`Creó horario: ${payload.day} ${payload.time} (${payload.activity})`);
  }

  slotForm.reset();
  slotEditorCard.classList.add("hidden");
});

function renderScheduleTable() {
  const tbody = document.getElementById("schedule-tbody");
  const isFounder = currentProfile.role === "founder";

  if (!schedulesCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No hay horarios programados aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = schedulesCache.map((slot) => {
    const isAvailable = !slot.assignedAdmin;
    const isMine = slot.assignedUid === currentUser.uid || slot.assignedAdmin === currentProfile.displayName;

    let actionButtons = "";
    if (isAvailable) {
      actionButtons += `<button class="btn btn-secondary btn-sm" onclick="claimScheduleSlot('${slot.id}')">Apuntarme</button> `;
    } else if (isMine && !isFounder) {
      actionButtons += `<button class="btn btn-ghost btn-sm" onclick="releaseScheduleSlot('${slot.id}')">Liberar</button> `;
    }

    if (isFounder) {
      actionButtons += `
        <button class="btn btn-ghost btn-sm" onclick="editScheduleSlot('${slot.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteScheduleSlot('${slot.id}')">Eliminar</button>
      `;
    }

    return `
      <tr>
        <td><strong>${slot.day}</strong></td>
        <td>${slot.time}</td>
        <td>${slot.activity}</td>
        <td>${slot.assignedAdmin || '<span class="muted">Sin asignar</span>'}</td>
        <td><span class="status-pill ${isAvailable ? "status-disponible" : "status-ocupado"}">
          ${isAvailable ? "Disponible" : "Asignado"}
        </span></td>
        <td>${actionButtons || "-"}</td>
      </tr>
    `;
  }).join("");
}

window.claimScheduleSlot = async (id) => {
  const slotRef = doc(db, "schedules", id);
  const snap = await getDoc(slotRef);
  if (!snap.exists() || snap.data().assignedAdmin) {
    alert("Este horario ya fue tomado por otro administrador.");
    return;
  }
  await updateDoc(slotRef, {
    assignedAdmin: currentProfile.displayName,
    assignedUid: currentUser.uid,
    status: "Asignado"
  });
  await registerSystemLog(`${currentProfile.displayName} se apuntó en ${snap.data().day} (${snap.data().activity})`);
};

window.releaseScheduleSlot = async (id) => {
  await updateDoc(doc(db, "schedules", id), {
    assignedAdmin: "",
    assignedUid: "",
    status: "Disponible"
  });
};

window.editScheduleSlot = (id) => {
  if (currentProfile.role !== "founder") return;
  const slot = schedulesCache.find((s) => s.id === id);
  if (!slot) return;
  document.getElementById("slot-id").value = slot.id;
  document.getElementById("slot-day").value = slot.day;
  document.getElementById("slot-time").value = slot.time;
  document.getElementById("slot-activity").value = slot.activity;
  document.getElementById("slot-admin").value = slot.assignedAdmin || "";
  document.getElementById("slot-form-title").textContent = "Editar Horario";
  slotEditorCard.classList.remove("hidden");
};

window.deleteScheduleSlot = async (id) => {
  if (currentProfile.role !== "founder") return;
  if (!confirm("¿Eliminar este espacio del horario semanal?")) return;
  await deleteDoc(doc(db, "schedules", id));
  await registerSystemLog("Eliminó un espacio del horario semanal.");
};

// Iniciar nueva semana conservando historial y liberando turnos
document.getElementById("btn-new-week").addEventListener("click", async () => {
  if (currentProfile.role !== "founder") return;
  if (!confirm("¿Archivar la programación actual y abrir una nueva semana para que los admins vuelvan a apuntarse?")) return;

  await addDoc(collection(db, "weekly_archives"), {
    archivedAt: serverTimestamp(),
    scheduleSnapshot: schedulesCache
  });

  const batch = writeBatch(db);
  schedulesCache.forEach((slot) => {
    batch.update(doc(db, "schedules", slot.id), {
      assignedAdmin: "",
      assignedUid: "",
      status: "Disponible"
    });
  });

  // Reiniciar contador semanal de puntos sin tocar el total acumulado
  membersCache.forEach((m) => {
    batch.update(doc(db, "members", m.id), {
      previousPoints: m.totalPoints || 0,
      weeklyPoints: 0
    });
  });

  await batch.commit();
  await registerSystemLog("Inició una nueva semana: horarios liberados y puntos semanales reiniciados.");
  alert("Nueva semana iniciada correctamente. El historial anterior fue conservado.");
});

/* ==========================================================================
   5. IDENTIFICACIÓN ÚNICA DE INTEGRANTES
   ========================================================================== */
const memberFormCard = document.getElementById("member-form-card");
const memberForm = document.getElementById("member-form");

document.getElementById("btn-toggle-member-form").addEventListener("click", () => {
  memberForm.reset();
  document.getElementById("mem-doc-id").value = "";
  document.getElementById("member-form-title").textContent = "Registrar Ficha de Integrante";
  memberFormCard.classList.remove("hidden");
});

document.getElementById("btn-cancel-member").addEventListener("click", () => {
  memberFormCard.classList.add("hidden");
});

memberForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const docId = document.getElementById("mem-doc-id").value;
  const alias = document.getElementById("mem-alias").value.trim();
  const roblox = document.getElementById("mem-roblox").value.trim();
  const whatsapp = document.getElementById("mem-whatsapp").value.trim();
  const discord = document.getElementById("mem-discord").value.trim();

  // Validar que no exista el mismo usuario de Roblox duplicado
  const duplicate = membersCache.find(
    (m) => m.roblox.toLowerCase() === roblox.toLowerCase() && m.id !== docId
  );
  if (duplicate) {
    alert(`Ya existe una ficha con el usuario de Roblox "${roblox}" (${duplicate.uniqueId}).`);
    return;
  }

  if (docId) {
    await updateDoc(doc(db, "members", docId), { alias, roblox, whatsapp, discord });
    await registerSystemLog(`Actualizó ficha de integrante: ${alias} (@${roblox})`);
  } else {
    const nextNum = String(membersCache.length + 1).padStart(3, "0");
    const uniqueId = `HD-${nextNum}`;
    await addDoc(collection(db, "members"), {
      uniqueId,
      alias,
      roblox,
      whatsapp,
      discord,
      totalPoints: 0,
      weeklyPoints: 0,
      previousPoints: 0,
      createdAt: serverTimestamp()
    });
    await registerSystemLog(`Creó ficha única ${uniqueId} para ${alias} (@${roblox})`);
  }

  memberForm.reset();
  memberFormCard.classList.add("hidden");
});

document.getElementById("filter-members-input").addEventListener("input", renderMembersTable);

function renderMembersTable() {
  const term = document.getElementById("filter-members-input").value.toLowerCase().trim();
  const tbody = document.getElementById("members-tbody");

  const filtered = membersCache.filter((m) =>
    [m.uniqueId, m.alias, m.roblox, m.whatsapp, m.discord]
      .filter(Boolean)
      .some((val) => val.toLowerCase().includes(term))
  );

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Sin integrantes encontrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((m) => `
    <tr>
      <td><span class="role-pill">${m.uniqueId}</span></td>
      <td><strong>${m.alias}</strong></td>
      <td>@${m.roblox}</td>
      <td>${m.whatsapp || "-"}</td>
      <td>${m.discord || "-"}</td>
      <td><strong>${m.totalPoints || 0} pts</strong></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="editMemberCard('${m.id}')">Editar</button>
      </td>
    </tr>
  `).join("");
}

window.editMemberCard = (id) => {
  const m = membersCache.find((x) => x.id === id);
  if (!m) return;
  document.getElementById("mem-doc-id").value = m.id;
  document.getElementById("mem-alias").value = m.alias;
  document.getElementById("mem-roblox").value = m.roblox;
  document.getElementById("mem-whatsapp").value = m.whatsapp || "";
  document.getElementById("mem-discord").value = m.discord || "";
  document.getElementById("member-form-title").textContent = `Editar Ficha ${m.uniqueId}`;
  memberFormCard.classList.remove("hidden");
};

/* ==========================================================================
   8, 4, 6. REGISTRO DE PARTICIPACIÓN, EVIDENCIAS Y FICHA ADMIN
   ========================================================================== */
const searchInput = document.getElementById("member-search-input");
const searchResults = document.getElementById("member-search-results");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    searchResults.classList.add("hidden");
    return;
  }

  const matches = membersCache.filter((m) =>
    [m.uniqueId, m.alias, m.roblox, m.whatsapp, m.discord]
      .filter(Boolean)
      .some((field) => field.toLowerCase().includes(q))
  );

  if (!matches.length) {
    searchResults.innerHTML = `<div class="autocomplete-item muted">No se encontró ficha. Créala primero en "Fichas de Integrantes".</div>`;
  } else {
    searchResults.innerHTML = matches.map((m) => `
      <div class="autocomplete-item" onclick="addParticipantToActivity('${m.id}')">
        <strong>${m.uniqueId}</strong> · ${m.alias}
        <span class="muted">(Roblox: @${m.roblox} | WA: ${m.whatsapp || "-"} | DC: ${m.discord || "-"})</span>
      </div>
    `).join("");
  }
  searchResults.classList.remove("hidden");
});

window.addParticipantToActivity = (memberId) => {
  const member = membersCache.find((m) => m.id === memberId);
  if (!member) return;
  if (!selectedParticipants.some((p) => p.id === memberId)) {
    selectedParticipants.push(member);
    renderSelectedParticipants();
    updateAdminSheetPreview();
  }
  searchInput.value = "";
  searchResults.classList.add("hidden");
};

window.removeParticipantFromActivity = (memberId) => {
  selectedParticipants = selectedParticipants.filter((p) => p.id !== memberId);
  renderSelectedParticipants();
  updateAdminSheetPreview();
};

function renderSelectedParticipants() {
  document.getElementById("selected-count").textContent = selectedParticipants.length;
  const container = document.getElementById("selected-participants-list");
  container.innerHTML = selectedParticipants.map((p) => `
    <span class="member-chip">
      ${p.uniqueId} · @${p.roblox}
      <button type="button" onclick="removeParticipantFromActivity('${p.id}')">✕</button>
    </span>
  `).join("");
}

// Vista previa de múltiples imágenes antes de subir
const evidenceInput = document.getElementById("act-evidences");
const evidencePreviewGrid = document.getElementById("evidence-preview-grid");

evidenceInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  selectedEvidenceFiles = [...selectedEvidenceFiles, ...files];
  renderEvidencePreviews();
  evidenceInput.value = "";
});

function renderEvidencePreviews() {
  evidencePreviewGrid.innerHTML = selectedEvidenceFiles.map((file, idx) => {
    const url = URL.createObjectURL(file);
    return `
      <div class="evidence-thumb">
        <img src="${url}" alt="Vista previa" onclick="openImageModal('${url}')" />
        <button type="button" class="remove-img" onclick="removeEvidenceFile(${idx})">✕</button>
      </div>
    `;
  }).join("");
}

window.removeEvidenceFile = (idx) => {
  selectedEvidenceFiles.splice(idx, 1);
  renderEvidencePreviews();
};

// Actualizar en vivo la Ficha exacta que usan los administradores
["act-name", "act-datetime", "act-points"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateAdminSheetPreview);
});

function buildAdminSheetText({ activityName, dateStr, adminName, participants, points }) {
  const listLines = participants.length
    ? participants.map((p, i) => `${i + 1}. @${p.roblox} (${p.alias})`).join("\n")
    : "1.\n2.\n3.\n4.\n5.";

  return `✦ REGISTRO DE ACTIVIDAD — HD

> Actividad: ${activityName || ""}
> Fecha: ${dateStr || ""}
> Administrador encargado: ${adminName || ""}

┆ PARTICIPANTES
${listLines}

┆ PUNTOS OTORGADOS
> +${points || 0} por participar

┆ EVIDENCIA
> Captura de la actividad.`;
}

function updateAdminSheetPreview() {
  const activityName = document.getElementById("act-name").value.trim();
  const rawDate = document.getElementById("act-datetime").value;
  const dateStr = rawDate ? new Date(rawDate).toLocaleString("es-MX") : "";
  const points = document.getElementById("act-points").value;
  const adminName = currentProfile ? currentProfile.displayName : "";

  document.getElementById("admin-sheet-preview").textContent = buildAdminSheetText({
    activityName,
    dateStr,
    adminName,
    participants: selectedParticipants,
    points
  });
}

document.getElementById("btn-copy-admin-sheet").addEventListener("click", () => {
  const text = document.getElementById("admin-sheet-preview").textContent;
  navigator.clipboard.writeText(text);
  alert("Ficha de registro copiada al portapapeles.");
});

// Enviar registro de actividad a revisión
document.getElementById("activity-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedParticipants.length) {
    alert("Debes seleccionar al menos un integrante mediante su ficha.");
    return;
  }
  if (!selectedEvidenceFiles.length) {
    alert("Debes adjuntar al menos una imagen como evidencia.");
    return;
  }

  const submitBtn = document.getElementById("btn-submit-activity");
  submitBtn.disabled = true;
  submitBtn.textContent = "Subiendo evidencias...";

  try {
    const uploadedUrls = [];
    for (const file of selectedEvidenceFiles) {
      const storageRef = ref(storage, `evidences/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      uploadedUrls.push(url);
    }

    const activityData = {
      activityName: document.getElementById("act-name").value.trim(),
      platform: document.getElementById("act-platform").value.trim(),
      dateTime: document.getElementById("act-datetime").value,
      pointsPerMember: Number(document.getElementById("act-points").value),
      notes: document.getElementById("act-notes").value.trim(),
      adminUid: currentUser.uid,
      adminName: currentProfile.displayName,
      participants: selectedParticipants.map((p) => ({
        memberId: p.id,
        uniqueId: p.uniqueId,
        alias: p.alias,
        roblox: p.roblox
      })),
      evidences: uploadedUrls,
      status: "PENDIENTE",
      createdAt: serverTimestamp()
    };

    await addDoc(collection(db, "activities"), activityData);
    await registerSystemLog(`${currentProfile.displayName} envió actividad "${activityData.activityName}" a revisión.`);

    e.target.reset();
    document.getElementById("act-points").value = 15;
    selectedParticipants = [];
    selectedEvidenceFiles = [];
    renderSelectedParticipants();
    renderEvidencePreviews();
    updateAdminSheetPreview();
    alert("Registro enviado correctamente. Queda pendiente de aprobación por Founder.");
  } catch (err) {
    console.error(err);
    alert("Error al guardar el registro. Verifica tu conexión.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Enviar Registro a Revisión ✦";
  }
});

/* ==========================================================================
   9. APROBACIÓN DE PUNTOS (EXCLUSIVO FOUNDER)
   ========================================================================== */
function renderApprovals() {
  const pending = activitiesCache.filter((a) => a.status === "PENDIENTE");
  const badge = document.getElementById("pending-badge");
  badge.textContent = pending.length;
  badge.classList.toggle("hidden", pending.length === 0);

  const container = document.getElementById("approvals-list");
  if (!pending.length) {
    container.innerHTML = `<div class="card glass-panel muted">No hay registros pendientes de aprobación.</div>`;
    return;
  }

  container.innerHTML = pending.map((act) => {
    const imgsHtml = (act.evidences || []).map((url) =>
      `<img src="${url}" alt="Evidencia" style="width:76px;height:76px;object-fit:cover;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,0.2)" onclick="openImageModal('${url}')" />`
    ).join("");

    const partsText = act.participants.map((p) => `${p.uniqueId} (@${p.roblox})`).join(", ");

    return `
      <div class="card glass-panel">
        <div class="row-between">
          <div>
            <h3>✦ ${act.activityName} <span class="role-pill">${act.platform}</span></h3>
            <p class="muted">Encargado: <strong>${act.adminName}</strong> · Fecha: ${new Date(act.dateTime).toLocaleString("es-MX")} · Puntos: <strong>+${act.pointsPerMember}</strong></p>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-success btn-sm" onclick="approveActivity('${act.id}')">✓ Aprobar y Sumar Puntos</button>
            <button class="btn btn-danger btn-sm" onclick="rejectActivity('${act.id}')">✕ Rechazar</button>
          </div>
        </div>
        <p style="margin:10px 0;font-size:0.88rem;"><strong>Participantes (${act.participants.length}):</strong> ${partsText}</p>
        ${act.notes ? `<p class="muted" style="margin-bottom:10px;">Observaciones: ${act.notes}</p>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${imgsHtml}</div>
      </div>
    `;
  }).join("");
}

window.approveActivity = async (activityId) => {
  if (currentProfile.role !== "founder") return;
  const actRef = doc(db, "activities", activityId);
  const actSnap = await getDoc(actRef);
  if (!actSnap.exists() || actSnap.data().status !== "PENDIENTE") return;

  const act = actSnap.data();
  const batch = writeBatch(db);

  // Sumar puntos de forma atómica a cada ficha única participante
  act.participants.forEach((p) => {
    const memberRef = doc(db, "members", p.memberId);
    batch.update(memberRef, {
      totalPoints: increment(act.pointsPerMember),
      weeklyPoints: increment(act.pointsPerMember)
    });
  });

  batch.update(actRef, {
    status: "APROBADA",
    reviewedBy: currentProfile.displayName,
    reviewedAt: serverTimestamp()
  });

  await batch.commit();
  await registerSystemLog(`Aprobó actividad "${act.activityName}" (+${act.pointsPerMember} pts a ${act.participants.length} integrantes).`);
};

window.rejectActivity = async (activityId) => {
  if (currentProfile.role !== "founder") return;
  const reason = prompt("Motivo del rechazo (opcional):") || "Sin especificar";
  await updateDoc(doc(db, "activities", activityId), {
    status: "RECHAZADA",
    rejectReason: reason,
    reviewedBy: currentProfile.displayName,
    reviewedAt: serverTimestamp()
  });
  await registerSystemLog(`Rechazó un registro de actividad (${reason}).`);
};

/* ==========================================================================
   7. TABLA GENERAL DE PUNTOS Y FORMATO EXACTO DE WHATSAPP
   ========================================================================== */
function renderPointsTable() {
  const sorted = [...membersCache].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
  const tbody = document.getElementById("points-tbody");

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Aún no hay integrantes registrados.</td></tr>`;
  } else {
    tbody.innerHTML = sorted.map((m, idx) => `
      <tr>
        <td><strong>#${idx + 1}</strong></td>
        <td>
          <strong>${m.alias}</strong> <span class="muted">(@${m.roblox})</span>
          <small style="display:block;color:var(--sky-accent);">${m.uniqueId}</small>
        </td>
        <td>${m.previousPoints || 0}</td>
        <td style="color:var(--success);">+${m.weeklyPoints || 0}</td>
        <td><strong>${m.totalPoints || 0} pts</strong></td>
      </tr>
    `).join("");
  }

  generateWhatsAppReport();
}

function generateWhatsAppReport() {
  const sorted = [...membersCache]
    .filter((m) => (m.totalPoints || 0) > 0)
    .sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));

  const summaryText = document.getElementById("wa-summary-activities").value.trim() || "las actividades de la semana";

  const participantsLines = sorted.length
    ? sorted.map((m) => `> @${m.roblox} \`+${m.totalPoints} puntos\``).join("\n")
    : `> @usuario \`+0 puntos\``;

  const formatted = `ㅤㅤㅤㅤ✦ *HD ┆ SISTEMA DE PUNTOS* ✦
ㅤㅤㅤ_Heaven's Doors_

> Se otorgan *+15 puntos* a cada integrante por participar y completar la actividad, fomentando la convivencia e integración dentro del clan.

ㅤㅤ┆ *PARTICIPANTES*

${participantsLines}

ㅤㅤ┆ *¿CÓMO FUNCIONA?*

> Los puntos se acumularán en una tabla de clasificación. Al alcanzar determinadas cantidades, podrán obtener recompensas por sus puntos acumulados.

ㅤㅤ┆ *RESUMEN*
> Se otorgaron puntos a los integrantes que participaron en las actividades: *${summaryText}*
ㅤㅤ_Always Have Faith._`;

  document.getElementById("whatsapp-output").textContent = formatted;
}

document.getElementById("btn-generate-wa").addEventListener("click", generateWhatsAppReport);
document.getElementById("wa-summary-activities").addEventListener("input", generateWhatsAppReport);
document.getElementById("btn-copy-wa").addEventListener("click", () => {
  navigator.clipboard.writeText(document.getElementById("whatsapp-output").textContent);
  alert("Tabla de puntos copiada con el formato exacto de WhatsApp.");
});

/* ==========================================================================
   3. REGISTRO DE INACTIVIDAD
   ========================================================================== */
const inactStart = document.getElementById("inact-start");
const inactEnd = document.getElementById("inact-end");
const inactDays = document.getElementById("inact-days");

function calcInactivityDays() {
  if (inactStart.value && inactEnd.value) {
    const start = new Date(inactStart.value);
    const end = new Date(inactEnd.value);
    const diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    inactDays.value = diff > 0 ? diff : 1;
  }
}
inactStart.addEventListener("change", calcInactivityDays);
inactEnd.addEventListener("change", calcInactivityDays);

document.getElementById("inactivity-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  calcInactivityDays();

  await addDoc(collection(db, "inactivities"), {
    adminUid: currentUser.uid,
    adminName: currentProfile.displayName,
    startDate: inactStart.value,
    endDate: inactEnd.value,
    days: Number(inactDays.value) || 1,
    type: document.getElementById("inact-type").value,
    reason: document.getElementById("inact-reason").value.trim(),
    affectedSchedules: document.getElementById("inact-affected").value.trim(),
    notes: document.getElementById("inact-notes").value.trim(),
    status: "Pendiente",
    createdAt: serverTimestamp()
  });

  await registerSystemLog(`${currentProfile.displayName} registró solicitud de inactividad (${inactDays.value} días).`);
  e.target.reset();
  alert("Solicitud de inactividad enviada.");
});

function renderInactivities() {
  const isFounder = currentProfile.role === "founder";
  const container = document.getElementById("inactivity-list");

  if (!inactivitiesCache.length) {
    container.innerHTML = `<p class="muted">No hay solicitudes de inactividad.</p>`;
    return;
  }

  container.innerHTML = inactivitiesCache.map((item) => {
    const statusClass = `status-${item.status.toLowerCase()}`;
    const founderControls = isFounder ? `
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-success btn-sm" onclick="setInactivityStatus('${item.id}', 'Aprobada')">Aprobar</button>
        <button class="btn btn-danger btn-sm" onclick="setInactivityStatus('${item.id}', 'Rechazada')">Rechazar</button>
        <button class="btn btn-ghost btn-sm" onclick="setInactivityStatus('${item.id}', 'Finalizada')">Finalizar</button>
      </div>
    ` : "";

    return `
      <div class="item-card">
        <div class="row-between">
          <strong>${item.adminName} · ${item.type} (${item.days} días)</strong>
          <span class="status-pill ${statusClass}">${item.status}</span>
        </div>
        <p class="muted" style="margin-top:4px;">Del ${item.startDate} al ${item.endDate}</p>
        <p style="font-size:0.85rem;margin-top:6px;"><strong>Motivo:</strong> ${item.reason}</p>
        <p style="font-size:0.85rem;"><strong>Horarios afectados:</strong> ${item.affectedSchedules}</p>
        ${item.notes ? `<p class="muted" style="font-size:0.82rem;">Obs: ${item.notes}</p>` : ""}
        ${founderControls}
      </div>
    `;
  }).join("");
}

window.setInactivityStatus = async (id, status) => {
  if (currentProfile.role !== "founder") return;
  await updateDoc(doc(db, "inactivities", id), { status });
  await registerSystemLog(`Cambió estado de inactividad a: ${status}`);
};

/* ==========================================================================
   10. CLASIFICACIÓN MENSUAL Y CIERRE SIN BORRAR HISTORIAL
   ========================================================================== */
function renderMonthlyPodium() {
  const sorted = [...membersCache].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
  const top3 = sorted.slice(0, 3);
  const medals = ["🥇 1er Lugar", "🥈 2do Lugar", "🥉 3er Lugar"];

  const container = document.getElementById("podium-container");
  container.innerHTML = [0, 1, 2].map((i) => {
    const m = top3[i];
    return `
      <div class="podium-card">
        <div class="podium-rank">${medals[i]}</div>
        <h3 style="margin:10px 0 4px;color:#fff;">${m ? m.alias : "Sin asignar"}</h3>
        <p class="muted">${m ? `@${m.roblox} (${m.uniqueId})` : "-"}</p>
        <strong style="display:block;font-size:1.3rem;margin-top:8px;color:var(--sky-accent);">
          ${m ? `${m.totalPoints || 0} puntos` : "0 puntos"}
        </strong>
      </div>
    `;
  }).join("");
}

document.getElementById("btn-close-month").addEventListener("click", async () => {
  if (currentProfile.role !== "founder") return;
  const monthLabel = prompt("Nombre del mes que se cierra (Ej. Noviembre 2026):");
  if (!monthLabel) return;

  const sorted = [...membersCache].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
  const top3 = sorted.slice(0, 3).map((m) => ({
    uniqueId: m.uniqueId,
    alias: m.alias,
    roblox: m.roblox,
    points: m.totalPoints || 0
  }));

  await addDoc(collection(db, "monthly_archives"), {
    monthLabel,
    top3,
    fullRanking: sorted.map((m) => ({ uniqueId: m.uniqueId, alias: m.alias, roblox: m.roblox, points: m.totalPoints || 0 })),
    closedAt: serverTimestamp(),
    closedBy: currentProfile.displayName
  });

  const batch = writeBatch(db);
  membersCache.forEach((m) => {
    batch.update(doc(db, "members", m.id), {
      totalPoints: 0,
      weeklyPoints: 0,
      previousPoints: 0
    });
  });
  await batch.commit();
  await registerSystemLog(`Cerró clasificación mensual (${monthLabel}) y reinició contadores del nuevo mes.`);
  alert(`Mes "${monthLabel}" cerrado y archivado. Puntos reiniciados para el nuevo mes.`);
});

function renderMonthlyArchives() {
  const container = document.getElementById("monthly-archives-list");
  if (!monthlyArchivesCache.length) {
    container.innerHTML = `<p class="muted">Aún no hay cierres mensuales archivados.</p>`;
    return;
  }

  container.innerHTML = monthlyArchivesCache.map((arc) => `
    <div class="item-card">
      <strong>👑 ${arc.monthLabel}</strong>
      <p style="font-size:0.86rem;margin-top:6px;">
        ${(arc.top3 || []).map((p, idx) => `#${idx + 1} ${p.alias} (@${p.roblox}) — ${p.points} pts`).join(" · ")}
      </p>
    </div>
  `).join("");
}

/* ==========================================================================
   11. HISTORIAL Y AUDITORÍA
   ========================================================================== */
document.getElementById("history-filter").addEventListener("change", renderHistory);

function renderHistory() {
  const filter = document.getElementById("history-filter").value;
  const container = document.getElementById("history-list");

  let items = [];
  if (filter === "ALL" || filter === "APROBADA" || filter === "RECHAZADA") {
    activitiesCache
      .filter((a) => filter === "ALL" || a.status === filter)
      .forEach((a) => {
        items.push({
          type: "ACTIVITY",
          date: a.createdAt?.toMillis ? a.createdAt.toMillis() : 0,
          data: a
        });
      });
  }

  if (filter === "ALL" || filter === "LOG") {
    logsCache.forEach((l) => {
      items.push({
        type: "LOG",
        date: l.timestamp?.toMillis ? l.timestamp.toMillis() : 0,
        data: l
      });
    });
  }

  items.sort((a, b) => b.date - a.date);

  if (!items.length) {
    container.innerHTML = `<div class="card glass-panel muted">Sin registros en el historial.</div>`;
    return;
  }

  container.innerHTML = items.slice(0, 50).map((entry) => {
    if (entry.type === "LOG") {
      return `
        <div class="item-card">
          <span class="role-pill">CAMBIO</span>
          <strong style="margin-left:6px;">${entry.data.by}:</strong> ${entry.data.action}
        </div>
      `;
    }

    const a = entry.data;
    const imgs = (a.evidences || []).map((u) =>
      `<img src="${u}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="openImageModal('${u}')" />`
    ).join("");

    return `
      <div class="item-card">
        <div class="row-between">
          <strong>✦ ${a.activityName} (${a.platform})</strong>
          <span class="status-pill status-${a.status.toLowerCase()}">${a.status}</span>
        </div>
        <p class="muted" style="font-size:0.83rem;margin:4px 0;">
          Admin: ${a.adminName} · Puntos: +${a.pointsPerMember} · Participantes: ${a.participants.map((p) => p.alias).join(", ")}
        </p>
        <div style="display:flex;gap:6px;margin-top:6px;">${imgs}</div>
      </div>
    `;
  }).join("");
}

/* ==========================================================================
   12. PANEL PRINCIPAL (DIFERENCIADO PARA FOUNDER Y ADMINS)
   ========================================================================== */
function renderDashboard() {
  if (!currentProfile) return;
  const isFounder = currentProfile.role === "founder";

  document.getElementById("dashboard-welcome").textContent = isFounder
    ? `Bienvenida, ${currentProfile.displayName}. Control total de Heaven’s Doors.`
    : `Hola, ${currentProfile.displayName}. Aquí tienes tus turnos y actividades.`;

  const statsContainer = document.getElementById("dashboard-stats");
  const upcomingContainer = document.getElementById("dash-upcoming-schedules");
  const secondaryTitle = document.getElementById("dash-secondary-title");
  const secondaryList = document.getElementById("dash-secondary-list");

  const pendingActs = activitiesCache.filter((a) => a.status === "PENDIENTE");
  const activeInacts = inactivitiesCache.filter((i) => i.status === "Aprobada");
  const pendingInacts = inactivitiesCache.filter((i) => i.status === "Pendiente");
  const availableSlots = schedulesCache.filter((s) => !s.assignedAdmin);

  if (isFounder) {
    const availableStaffCount = Math.max(0, staffCache.length - activeInacts.length);
    statsContainer.innerHTML = `
      <div class="stat-box"><span>Admins Disponibles</span><strong>${availableStaffCount} / ${staffCache.length}</strong></div>
      <div class="stat-box"><span>Registros Pendientes</span><strong>${pendingActs.length}</strong></div>
      <div class="stat-box"><span>Inactividades Pendientes</span><strong>${pendingInacts.length}</strong></div>
      <div class="stat-box"><span>Integrantes Registrados</span><strong>${membersCache.length}</strong></div>
    `;

    upcomingContainer.innerHTML = schedulesCache.slice(0, 6).map((s) => `
      <div class="item-card row-between">
        <span><strong>${s.day} ${s.time}</strong> · ${s.activity}</span>
        <span class="muted">${s.assignedAdmin || "Disponible"}</span>
      </div>
    `).join("") || `<p class="muted">Sin horarios configurados.</p>`;

    secondaryTitle.textContent = "✦ Top Clasificación Actual";
    const top5 = [...membersCache].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0)).slice(0, 5);
    secondaryList.innerHTML = top5.map((m, idx) => `
      <div class="item-card row-between">
        <span><strong>#${idx + 1} ${m.alias}</strong> (@${m.roblox})</span>
        <span style="color:var(--sky-accent);font-weight:700;">${m.totalPoints || 0} pts</span>
      </div>
    `).join("") || `<p class="muted">Sin puntos aún.</p>`;
  } else {
    const mySlots = schedulesCache.filter((s) => s.assignedUid === currentUser.uid || s.assignedAdmin === currentProfile.displayName);
    const myActivities = activitiesCache.filter((a) => a.adminUid === currentUser.uid);

    statsContainer.innerHTML = `
      <div class="stat-box"><span>Mis Turnos Asignados</span><strong>${mySlots.length}</strong></div>
      <div class="stat-box"><span>Horarios Disponibles</span><strong>${availableSlots.length}</strong></div>
      <div class="stat-box"><span>Mis Registros Enviados</span><strong>${myActivities.length}</strong></div>
    `;

    upcomingContainer.innerHTML = (mySlots.length ? mySlots : availableSlots.slice(0, 5)).map((s) => `
      <div class="item-card row-between">
        <span><strong>${s.day} ${s.time}</strong> · ${s.activity}</span>
        <span class="status-pill ${s.assignedAdmin ? "status-ocupado" : "status-disponible"}">
          ${s.assignedAdmin ? "Tu turno" : "Disponible"}
        </span>
      </div>
    `).join("") || `<p class="muted">No hay horarios próximos.</p>`;

    secondaryTitle.textContent = "✦ Estado de Mis Registros";
    secondaryList.innerHTML = myActivities.slice(0, 5).map((a) => `
      <div class="item-card row-between">
        <span><strong>${a.activityName}</strong> (+${a.pointsPerMember} pts)</span>
        <span class="status-pill status-${a.status.toLowerCase()}">${a.status}</span>
      </div>
    `).join("") || `<p class="muted">Aún no has enviado registros.</p>`;
  }
}

/* ==========================================================================
   1. CREACIÓN DE CUENTAS DE ADMINISTRADOR (SOLO FOUNDER)
   ========================================================================== */
document.getElementById("create-admin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile.role !== "founder") return;

  const displayName = document.getElementById("new-admin-display").value.trim();
  const username = document.getElementById("new-admin-user").value.trim().toLowerCase().replace(/\s+/g, "");
  const password = document.getElementById("new-admin-pass").value;

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, formatAuthEmail(username), password);
    await setDoc(doc(db, "staff", cred.user.uid), {
      uid: cred.user.uid,
      username,
      displayName,
      role: "admin",
      active: true,
      createdAt: serverTimestamp()
    });
    await signOut(secondaryAuth);
    await registerSystemLog(`Creó cuenta de administrador para ${displayName} (${username})`);
    e.target.reset();
    alert(`Cuenta creada.\nUsuario: ${username}\nContraseña: ${password}`);
  } catch (err) {
    alert("Error al crear cuenta (el usuario ya existe o la contraseña tiene menos de 6 caracteres).");
  }
});

function renderStaffList() {
  const container = document.getElementById("staff-list");
  container.innerHTML = staffCache.map((s) => `
    <div class="item-card row-between">
      <div>
        <strong>${s.displayName}</strong>
        <span class="muted" style="display:block;font-size:0.8rem;">Usuario: ${s.username}</span>
      </div>
      <span class="role-pill ${s.role === "founder" ? "founder" : ""}">${s.role.toUpperCase()}</span>
    </div>
  `).join("");
}

/* ==========================================================================
   MODAL DE VISUALIZACIÓN DE IMÁGENES
   ========================================================================== */
const imageModal = document.getElementById("image-modal");
window.openImageModal = (url) => {
  document.getElementById("modal-img-target").src = url;
  imageModal.classList.remove("hidden");
};
document.getElementById("close-image-modal").addEventListener("click", () => {
  imageModal.classList.add("hidden");
});
