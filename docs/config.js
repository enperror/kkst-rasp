// Конфигурация приложения (публичная — секретов здесь НЕТ).
window.CONFIG = {
  WORKER_URL: "https://kkst-rasp.vadimshirokikh22.workers.dev",

  // Резервный публичный ключ Яндекс.Диска — старый, сработает если техникум вернётся на Яндекс
  FALLBACK_PUBLIC_KEY: "G2u6am+aPfLVjN4bBQx5se4CgvhZz7fJrbYFk8rQhVrCHXWHDKYdDWALjqMHzZ+wq/J6bpmRyOJonT3VoXnDag==",

  // НОВОЕ v2.1: резервная Google-таблица — срабатывает когда сайт техникума банится UserGate (как сейчас)
  // Твоя актуальная ссылка: 1Zpi_zeo3whDWeX1QqX7oFYnoeDTRh15XGjFyB3cgW8E — 19-20.10.2026
  // Если техникум поменяет таблицу, просто поменяй ID здесь и запушь
  FALLBACK_GOOGLE_URL: "https://docs.google.com/spreadsheets/d/1Zpi_zeo3whDWeX1QqX7oFYnoeDTRh15XGjFyB3cgW8E/edit?usp=sharing",
};
