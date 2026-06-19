import type { MerchantRule } from './types.js'

/** Portuguese (BR/PT) generic-keyword rules. Keys are accent-free, normalized substrings. */
export const ptRules: MerchantRule[] = [
  // Comida
  { key: 'restaurante', category: 'cat-food' },
  { key: 'lanchonete', category: 'cat-food' },
  { key: 'padaria', category: 'cat-food' },
  { key: 'mercado', category: 'cat-food' },
  { key: 'supermercado', category: 'cat-food' },
  { key: 'acougue', category: 'cat-food' },
  { key: 'hortifruti', category: 'cat-food' },

  // Transporte (sem 'gas' isolado — colide com 'gasolina')
  { key: 'posto', category: 'cat-transport' },
  { key: 'gasolina', category: 'cat-transport' },
  { key: 'combustivel', category: 'cat-transport' },
  { key: 'estacionamento', category: 'cat-transport' },
  { key: 'pedagio', category: 'cat-transport' },
  { key: 'metro', category: 'cat-transport' },

  // Moradia
  { key: 'aluguel', category: 'cat-housing' },
  { key: 'condominio', category: 'cat-housing' },

  // Contas / utilidades
  { key: 'conta de luz', category: 'cat-utilities' },
  { key: 'energia', category: 'cat-utilities' },
  { key: 'conta de agua', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'telefone', category: 'cat-utilities' },

  // Saude
  { key: 'farmacia', category: 'cat-health' },
  { key: 'drogaria', category: 'cat-health' },
  { key: 'medico', category: 'cat-health' },
  { key: 'dentista', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },
  { key: 'academia', category: 'cat-health' },

  // Educacao
  { key: 'escola', category: 'cat-education' },
  { key: 'faculdade', category: 'cat-education' },
  { key: 'mensalidade', category: 'cat-education' },
  { key: 'curso', category: 'cat-education' },

  // Lazer
  { key: 'cinema', category: 'cat-leisure' },
  { key: 'teatro', category: 'cat-leisure' },

  // Viagem
  { key: 'hotel', category: 'cat-travel' },
  { key: 'pousada', category: 'cat-travel' },
  { key: 'passagem', category: 'cat-travel' },

  // Renda
  { key: 'salario', category: 'cat-salary' },

  // Impostos
  { key: 'imposto', category: 'cat-taxes' },
  { key: 'iptu', category: 'cat-taxes' },
  { key: 'ipva', category: 'cat-taxes' },
  { key: 'darf', category: 'cat-taxes' },
]
