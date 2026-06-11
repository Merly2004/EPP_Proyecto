const express = require('express');
const bodyParser = require('body-parser');
const pool = require('./db'); 
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// Inicialización de Firebase
//const serviceAccount = require('./serviceAccountKey.json');
const privateKey = process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : '';

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
    })
});


const app = express();
app.use(bodyParser.json());

// La URL base vendrá de las variables de entorno de Render
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PORT = process.env.PORT || 3000;

// Configuración de Multer (Almacenamiento de fotos de perfil)
const storage = multer.diskStorage({
    destination: './imagenes/perfiles/',
    filename: (req, file, cb) => {
        cb(null, 'foto_' + req.params.id + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });



/**
 * Función para disparar notificaciones Push a Firebase
 */
async function dispararAlertaPush(nombreSalon, tipoFalta) {
    console.log("Intentando enviar notificación de:", nombreSalon);
    const message = {
        notification: {
            title: 'ALERTA: ' + nombreSalon,
            body: 'Se ha detectado: ' + tipoFalta
        },
        topic: 'alertas_seguridad',
        android: {
            priority: 'high',
            notification: { channelId: 'alertas_urgentes' }
        }
    };
    try {
        await admin.messaging().send(message);
    } catch (error) {
        console.error('[Firebase] Error:', error);
    }
}

// --- RUTAS DE LA API ---

// 1. Login
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    try {
        const result = await pool.query("SELECT id_docente, nombre FROM docentes WHERE correo = $1 AND contrasena = $2", [correo, contrasena]);
        if (result.rows.length > 0) {
            res.json({ success: true, ...result.rows[0] });
        } else {
            res.json({ success: false, message: "Credenciales incorrectas" });
        }
    } catch (err) { res.status(500).json({ success: false }); }
});

// 2. Obtener Perfil
app.get('/api/perfil/:id', async (req, res) => {
    try {
        const query = 'SELECT nombre, especialidad, foto_url, telefono FROM docentes WHERE id_docente = $1';
        const result = await pool.query(query, [req.params.id]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ success: false });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 3. Subir foto de perfil
app.post('/api/subir-foto/:id', upload.single('foto'), async (req, res) => {
    try {
        const resOld = await pool.query('SELECT foto_url FROM docentes WHERE id_docente = $1', [req.params.id]);
        const fotoVieja = resOld.rows[0]?.foto_url;
        if (fotoVieja && fs.existsSync('./imagenes/perfiles/' + fotoVieja)) {
            fs.unlinkSync('./imagenes/perfiles/' + fotoVieja);
        }
        await pool.query('UPDATE docentes SET foto_url = $1 WHERE id_docente = $2', [req.file.filename, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});
// Servir imágenes
app.use('/imagenes', express.static(path.join(__dirname, 'public/imagenes')));

// 4. Historial General (CORREGIDO: Incluye imágenes con ruta completa)
app.get('/api/alertas-historial', async (req, res) => {
    try {
        const query = `
            SELECT a.*, COALESCE(s.nombre_salon, 'Área General') as nombre_salon,
            CASE 
                WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                ELSE '${BASE_URL}/imagenes/' || a.evidencia_url 
            END as evidencia_url
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            ORDER BY a.fecha_hora DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 5. Alerta Actual (CORREGIDO)
app.get('/api/alerta-actual/:id_docente', async (req, res) => {
    const idDocente = req.params.id_docente;
    try {
        const query = `
            SELECT a.*, s.nombre_salon,
            CASE 
                WHEN a.evidencia_url IS NULL OR a.evidencia_url = '' THEN ''
                WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                ELSE '${BASE_URL}/imagenes/' || a.evidencia_url 
            END as evidencia_url
            FROM alertas a
            JOIN camaras c ON a.codigo_camara = c.codigo_camara
            JOIN salones s ON c.id_salon = s.id_salon
            JOIN horarios_clases h ON s.id_salon = h.id_salon
            WHERE h.id_docente = $1
            ORDER BY a.fecha_hora DESC LIMIT 1;
        `;
        const result = await pool.query(query, [idDocente]);
        res.json({ success: true, data: result.rows[0] || {} });
    } catch (err) { 
        console.error("Error en alerta-actual:", err);
        res.status(500).json({ success: false, message: err.message }); 
    }
});

// 6. Obtener Alertas de un salón
app.get('/api/alertas/:id_salon', async (req, res) => {
    const { id_salon } = req.params;
    try {
        const query = `
            SELECT a.tipo_falta, a.fecha_hora, a.evidencia_url, a.severidad, 
                   COALESCE(s.nombre_salon, 'N/A') as nombre_salon, 
                   COALESCE(a.codigo_camara, 'Sin asignar') as codigo_camara
            FROM alertas a
            LEFT JOIN camaras c ON a.codigo_camara = c.codigo_camara
            LEFT JOIN salones s ON c.id_salon = s.id_salon
            WHERE (c.id_salon = $1 OR c.id_salon IS NULL) 
            ORDER BY a.fecha_hora DESC;
        `;
        const result = await pool.query(query, [id_salon]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error al obtener alertas" });
    }
});

// 7. Historial filtrado por docente (Corregida para la nube)
app.get('/api/alertas-historial/:id_docente', async (req, res) => {
    const { id_docente } = req.params;
    try {
        const query = `
            SELECT DISTINCT ON (a.id_alerta) a.*, s.nombre_salon,
            CASE 
                WHEN a.evidencia_url IS NULL OR a.evidencia_url = '' THEN ''
                WHEN a.evidencia_url LIKE 'http%' THEN a.evidencia_url
                ELSE '${BASE_URL}/imagenes/' || a.evidencia_url 
            END as evidencia_url
            FROM alertas a
            JOIN camaras c ON a.codigo_camara = c.codigo_camara
            JOIN salones s ON c.id_salon = s.id_salon
            JOIN horarios_clases h ON s.id_salon = h.id_salon
            WHERE h.id_docente = $1
            ORDER BY a.id_alerta, a.fecha_hora DESC;
        `;
        const result = await pool.query(query, [id_docente]);
        res.json({ success: true, data: result.rows });
    } catch (err) { 
        console.error("Error en historial filtrado:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 8. Notificación IA (Flask)
app.post('/api/notificacion-flask', async (req, res) => {
    const { codigo_camara, tipo_falta, evidencia_url, severidad } = req.body;
    try {
        await pool.query('INSERT INTO alertas (codigo_camara, tipo_falta, evidencia_url, severidad, fecha_hora) VALUES ($1, $2, $3, $4, NOW())', [codigo_camara, tipo_falta, evidencia_url, severidad]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});



// ESCUCHA
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor S.E.P.P. activo en puerto ${PORT}`);
});
