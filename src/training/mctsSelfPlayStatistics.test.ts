import { describe, expect, it } from 'vitest'
import {
  classifyEffectSize,
  cohensD,
  cohensH,
  designEffect,
  intraclassCorrelation,
  mean,
  median,
  normalTwoSidedPValue,
  oneSampleMeanZTest,
  sampleStandardDeviation,
  standardNormalCdf,
  wilcoxonSignedRankTest,
} from './mctsSelfPlayStatistics'

describe('estadísticos descriptivos', () => {
  it('calcula media, mediana y desviación típica muestral', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 4)
    expect(sampleStandardDeviation([5])).toBe(0)
    expect(mean([])).toBe(0)
  })
})

describe('normal estándar', () => {
  it('reproduce valores conocidos de la función de distribución', () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 6)
    expect(standardNormalCdf(1.96)).toBeCloseTo(0.975, 4)
    expect(standardNormalCdf(-1.96)).toBeCloseTo(0.025, 4)
    expect(standardNormalCdf(2.5758)).toBeCloseTo(0.995, 4)
  })

  it('devuelve valores p bilaterales conocidos', () => {
    expect(normalTwoSidedPValue(0)).toBeCloseTo(1, 6)
    expect(normalTwoSidedPValue(1.959964)).toBeCloseTo(0.05, 3)
    expect(normalTwoSidedPValue(-1.959964)).toBeCloseTo(0.05, 3)
    expect(normalTwoSidedPValue(Number.NaN)).toBe(1)
  })
})

describe('prueba z de una muestra', () => {
  it('no detecta diferencia cuando la media coincide con el valor nulo', () => {
    const test = oneSampleMeanZTest([0.4, 0.5, 0.6, 0.5, 0.5], 0.5)
    expect(test.mean).toBe(0.5)
    expect(test.z).toBe(0)
    expect(test.pValue).toBe(1)
  })

  it('detecta un desplazamiento claro de la media', () => {
    const values = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? 0.9 : 1.1))
    const test = oneSampleMeanZTest(values, 0)
    expect(test.mean).toBeCloseTo(1, 6)
    expect(test.pValue).toBeLessThan(0.001)
  })
})

describe('prueba de Wilcoxon de rangos con signo', () => {
  it('devuelve resultado neutro cuando todas las diferencias son nulas', () => {
    const test = wilcoxonSignedRankTest([0.5, 0.5, 0.5], 0.5)
    expect(test.nonZero).toBe(0)
    expect(test.zeroDifferences).toBe(3)
    expect(test.pValue).toBe(1)
    expect(test.rankBiserialCorrelation).toBe(0)
  })

  it('reparte los rangos y detecta una muestra claramente positiva', () => {
    const test = wilcoxonSignedRankTest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0)
    expect(test.nonZero).toBe(10)
    expect(test.wPlus).toBe(55)
    expect(test.wMinus).toBe(0)
    expect(test.rankBiserialCorrelation).toBe(1)
    expect(test.pValue).toBeLessThan(0.01)
  })

  it('es simétrica al cambiar el signo de todos los valores', () => {
    const positive = wilcoxonSignedRankTest([3, -1, 4, 2, -5, 6], 0)
    const negative = wilcoxonSignedRankTest([-3, 1, -4, -2, 5, -6], 0)
    expect(negative.pValue).toBe(positive.pValue)
    expect(negative.wPlus).toBe(positive.wMinus)
    expect(negative.rankBiserialCorrelation).toBe(-positive.rankBiserialCorrelation)
  })

  it('promedia los rangos empatados', () => {
    const test = wilcoxonSignedRankTest([1, 1, 1, 1], 0)
    // Cuatro empates comparten el rango medio 2,5, de modo que W+ = 10.
    expect(test.wPlus).toBe(10)
    expect(test.wMinus).toBe(0)
  })
})

describe('dependencia dentro de las parejas', () => {
  it('es cero cuando las parejas no comparten información', () => {
    // Las cuatro combinaciones equiprobables no comparten información dentro de la pareja.
    const clusters = Array.from({ length: 10 }, () => [
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ]).flat()
    expect(Math.abs(intraclassCorrelation(clusters))).toBeLessThan(0.05)
  })

  it('es alta cuando los dos miembros de cada pareja coinciden siempre', () => {
    const clusters = Array.from({ length: 30 }, (_, index) => [index % 2, index % 2])
    expect(intraclassCorrelation(clusters)).toBeCloseTo(1, 4)
  })

  it('convierte la correlación intraclase en efecto de diseño', () => {
    expect(designEffect(0, 2)).toBe(1)
    expect(designEffect(0.5, 2)).toBe(1.5)
  })

  it('rechaza conglomerados de tamaños distintos', () => {
    expect(() =>
      intraclassCorrelation([
        [1, 0],
        [1, 0, 1],
      ]),
    ).toThrow(/equal/)
    // Un conglomerado de un solo elemento no aporta información y se descarta.
    expect(intraclassCorrelation([[1, 0], [1]])).toBe(0)
  })
})

describe('tamaños del efecto', () => {
  it('calcula la h de Cohen frente a 0,5', () => {
    expect(cohensH(0.5)).toBe(0)
    expect(cohensH(0.6)).toBeCloseTo(0.2014, 3)
    expect(cohensH(0.4)).toBeCloseTo(-0.2014, 3)
  })

  it('calcula la d de Cohen de una muestra', () => {
    expect(cohensD([1, 1, 1], 1)).toBe(0)
    expect(cohensD([2, 4, 4, 4, 5, 5, 7, 9], 5)).toBeCloseTo(0, 1)
  })

  it('clasifica la magnitud con los umbrales convencionales', () => {
    expect(classifyEffectSize(0.05)).toBe('negligible')
    expect(classifyEffectSize(-0.3)).toBe('small')
    expect(classifyEffectSize(0.6)).toBe('medium')
    expect(classifyEffectSize(1.2)).toBe('large')
  })
})
