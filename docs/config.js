// Конфигурация приложения (публичная — секретов здесь НЕТ).
window.CONFIG = {
  // URL вашего Cloudflare Worker (см. worker/worker.js и README).
  // Воркер хранит токен бота и достаёт свежую ссылку на файл с сайта ККСТ.
  // Пример: "https://kkst-rasp.ваш-логин.workers.dev"
  // Пусто — приложение работает в режиме «только скачать PNG»
  // на резервном ключе.
  WORKER_URL: "https://kkst-rasp.vadimshirokikh22.workers.dev",

  // Резервный публичный ключ Яндекс.Диска — используется, если воркер
  // недоступен или не смог достать свежую ссылку с сайта техникума.
  // Ссылка на сайте меняется, так что это именно запасной вариант —
  // основной путь: воркер каждый раз берёт актуальную ссылку со страницы
  // https://kkst.kemobl.ru/studentam/raspisanie/
  FALLBACK_PUBLIC_KEY: "G2u6am+aPfLVjN4bBQx5se4CgvhZz7fJrbYFk8rQhVrCHXWHDKYdDWALjqMHzZ+wq/J6bpmRyOJonT3VoXnDag==",
};
