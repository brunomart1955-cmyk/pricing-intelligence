// Configuração do Supabase (Project Settings → API).
// A "anon public key" é feita para ficar no navegador: quem protege os dados
// são as regras de segurança (RLS) do arquivo supabase.sql.
// NUNCA coloque aqui a "service_role key".
window.SR_CONFIG = {
  supabaseUrl: 'https://lmazvxvudbhoivgvhbin.supabase.co',      // ex.: 'https://abcdxyz.supabase.co'
  supabaseAnonKey: 'sb_publishable_nBsq0Xy8Vi6ZBrbL_BrzdQ_c3JNnBrO'   // ex.: 'eyJhbGciOiJIUzI1NiIs...'
};
