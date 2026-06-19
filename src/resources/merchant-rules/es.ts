import type { MerchantRule } from './types.js'

/** Spanish generic-keyword rules. Keys are accent-free, normalized substrings. */
export const esRules: MerchantRule[] = [
  // Comida
  { key: 'restaurante', category: 'cat-food' },
  { key: 'cafeteria', category: 'cat-food' },
  { key: 'panaderia', category: 'cat-food' },
  { key: 'supermercado', category: 'cat-food' },
  { key: 'mercado', category: 'cat-food' },
  { key: 'carniceria', category: 'cat-food' },

  // Transporte (sin 'gas' suelto — colisiona con 'gasolina')
  { key: 'gasolinera', category: 'cat-transport' },
  { key: 'gasolina', category: 'cat-transport' },
  { key: 'combustible', category: 'cat-transport' },
  { key: 'estacionamiento', category: 'cat-transport' },
  { key: 'peaje', category: 'cat-transport' },
  { key: 'metro', category: 'cat-transport' },

  // Vivienda
  { key: 'alquiler', category: 'cat-housing' },
  { key: 'hipoteca', category: 'cat-housing' },
  { key: 'comunidad', category: 'cat-housing' },

  // Servicios
  { key: 'electricidad', category: 'cat-utilities' },
  { key: 'recibo de luz', category: 'cat-utilities' },
  { key: 'agua', category: 'cat-utilities' },
  { key: 'internet', category: 'cat-utilities' },
  { key: 'telefono', category: 'cat-utilities' },

  // Salud
  { key: 'farmacia', category: 'cat-health' },
  { key: 'medico', category: 'cat-health' },
  { key: 'dentista', category: 'cat-health' },
  { key: 'hospital', category: 'cat-health' },
  { key: 'gimnasio', category: 'cat-health' },

  // Educacion
  { key: 'colegio', category: 'cat-education' },
  { key: 'universidad', category: 'cat-education' },
  { key: 'matricula', category: 'cat-education' },
  { key: 'curso', category: 'cat-education' },

  // Ocio
  { key: 'cine', category: 'cat-leisure' },
  { key: 'teatro', category: 'cat-leisure' },

  // Viajes
  { key: 'hotel', category: 'cat-travel' },
  { key: 'vuelo', category: 'cat-travel' },
  { key: 'pasaje', category: 'cat-travel' },

  // Ingresos
  { key: 'nomina', category: 'cat-salary' },
  { key: 'salario', category: 'cat-salary' },
  { key: 'sueldo', category: 'cat-salary' },

  // Impuestos
  { key: 'impuesto', category: 'cat-taxes' },
  { key: 'hacienda', category: 'cat-taxes' },
]
