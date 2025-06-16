// clickhouse.js
const { createClient } = require('@clickhouse/client');

const client = createClient({
  url: 'https://m84z4xv4dv.us-east-1.aws.clickhouse.cloud:8443/',
  username: 'default',
  password: '1mheJN~yMgyjk',
  database: 'default',
  tls: {
    rejectUnauthorized: true,
  },
});

async function getReportData() {
  const query = `
            WITH total_general AS (
            SELECT
                producto,
                SUM(venta) AS venta_total,
                SUM(cantidad_vendida) AS cantidad_vendida_total,
                MIN(fecha_ingreso) AS fecha_ingreso_minima
            FROM colombia.analisis_por_categoria_de_producto
            WHERE fecha_ingreso = toDate('2025-04-11')
            GROUP BY producto
            ),
            venta_global_total AS (
            SELECT SUM(venta) AS venta_total_global
            FROM colombia.analisis_por_categoria_de_producto
            WHERE fecha_ingreso = toDate('2025-04-11')
            ),
            venta_global_por_grupo AS (
            SELECT
                grupo,
                SUM(venta) AS venta_global
            FROM colombia.analisis_por_categoria_de_producto
            WHERE fecha_ingreso = toDate('2025-04-11')
            GROUP BY grupo
            ),
            venta_global_por_contenedor AS (
            SELECT
                contenedor,
                SUM(venta) AS venta_global
            FROM colombia.analisis_por_categoria_de_producto
            WHERE fecha_ingreso = toDate('2025-04-11')
            GROUP BY contenedor
            ),
            th_mov_logisticos_inventario_extra AS (
            SELECT
                mli.clase_movimiento,
                mli.valor,
                mli.fecha,
                mli.lote,
                mli.grupo,
                mli.producto,
                nmm.marca,
                nmm.grupo AS perfil_producto,
                nmm.segmento,
                nmm.dato5 AS material_produccion,
                nmm.paqueteria,
                mli.material
            FROM colombia.th_mov_logisticos_inventario mli
            LEFT JOIN colombia.nuevo_maestra_material nmm ON mli.material = nmm.material
            ),
            CompraTotal AS (
            SELECT
                producto,
                SUM(valor) AS costo_total_compras
            FROM th_mov_logisticos_inventario_extra
            WHERE clase_movimiento = 'COMPRA' AND fecha = toDate('2025-04-11')
            GROUP BY producto
            ),
            VentasDiarias AS (
            SELECT
                toDate(fecha) AS fecha,
                producto,
                SUM(valor) AS valor_venta
            FROM th_mov_logisticos_inventario_extra
            WHERE clase_movimiento = 'VENTA' AND fecha = toDate('2025-04-11')
            GROUP BY fecha, producto
            ),
            VentasAcumuladas AS (
            SELECT
                fecha,
                producto,
                valor_venta,
                SUM(valor_venta) OVER (
                PARTITION BY producto
                ORDER BY fecha
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS venta_acumulada
            FROM VentasDiarias
            ),
            ROI_Calculation AS (
            SELECT
                c.producto,
                c.costo_total_compras,
                v.fecha,
                COALESCE(v.valor_venta, 0) AS valor_venta,
                COALESCE(v.venta_acumulada, 0) AS venta_acumulada,
                (COALESCE(v.venta_acumulada, 0) - c.costo_total_compras) AS diferencia,
                IF(abs(COALESCE(v.venta_acumulada, 0)) >= c.costo_total_compras, 1, 0) AS superado
            FROM CompraTotal c
            LEFT JOIN VentasAcumuladas v ON c.producto = v.producto
            ),
            ROI_Result AS (
            SELECT
                producto,
                IF(MAX(COALESCE(superado, 0)) = 1,
                minIf(fecha, superado = 1),
                toDate('2025-04-11')) AS fecha_roi
            FROM ROI_Calculation
            GROUP BY producto
            )

            SELECT
            a.contenedor AS contenedor,
            a.producto AS producto,
            MIN(a.fecha_ingreso) AS fecha_ingreso,
            DATEDIFF('day', MIN(a.fecha_ingreso), MIN(COALESCE(r.fecha_roi, toDate('2025-04-11')))) AS dias_inv,
            SUM(a.compra) AS compra,
            SUM(a.venta) AS venta,
            any(venta_global_total.venta_total_global) AS venta_total_global,
            any(vg.venta_global) AS venta_grupo,
            any(vc.venta_global) AS venta_contenedor,
            SUM(a.venta) AS total_venta,
            (SUM(a.venta) - SUM(a.compra)) / NULLIF(SUM(a.compra), 0) AS roi,
            MIN(COALESCE(r.fecha_roi, toDate('2025-04-11'))) AS fecha_roi,
            COALESCE(SUM(a.venta) / NULLIF(venta_total_global, 0), 0) AS porcentaje_participacion,
            COALESCE(SUM(a.venta) / NULLIF(venta_contenedor, 0), 0) AS porcentaje_participacion_relativo,
            SUM(a.cantidad_comprada) AS cantidad_comprada,
            SUM(a.cantidad_vendida) AS cantidad_vendida,
            CASE
                WHEN SUM(a.cantidad_comprada) = 0 THEN 0
                ELSE COALESCE(SUM(a.cantidad_vendida), 0) / NULLIF(SUM(a.cantidad_comprada), 0)
            END AS porcentaje_evacuacion,
            SUM(a.inventario_actual) AS inventario_actual,
            CASE
                WHEN (toDate('2025-04-11') - t.fecha_ingreso_minima) = 0 THEN 0
                WHEN COALESCE(SUM(a.cantidad_vendida), 0) = 0 THEN 0
                ELSE COALESCE(SUM(a.inventario_actual), 0) /
                NULLIF((COALESCE(SUM(a.cantidad_vendida), 0) /
                NULLIF((toDate('2025-04-11') - t.fecha_ingreso_minima) / 28, 0)), 0)
            END AS miu,
            COUNT(DISTINCT a.producto) AS quantity,
            (SUM(a.compra) / NULLIF(SUM(a.cantidad_comprada), 0)) AS unitary_cost
            FROM colombia.analisis_por_categoria_de_producto a
            LEFT JOIN total_general t ON a.producto = t.producto
            LEFT JOIN venta_global_total ON 1 = 1
            LEFT JOIN venta_global_por_grupo vg ON vg.grupo = a.grupo
            LEFT JOIN venta_global_por_contenedor vc ON vc.contenedor = a.contenedor
            LEFT JOIN ROI_Result r ON LOWER(a.producto) = LOWER(r.producto)
            WHERE a.fecha_ingreso = toDate('2025-04-11')
            GROUP BY a.contenedor, a.producto, t.venta_total, t.fecha_ingreso_minima, a.contenedor
            HAVING SUM(a.venta) > 0
            ORDER BY venta ASC
  `;

  try {
    const resultSet = await client.query({ query, format: 'JSON' });
    const result = await resultSet.json();
    return result.data;
  } catch (error) {
    console.error('Error al ejecutar la consulta:', error);
    throw error;
  }
};

async function getReportDataQ2(df) {
    if (!df || df.length === 0) {
      console.log("DataFrame vacío. No hay datos disponibles.");
      return [];
    }
  
    const dfWithYear = df.map(row => ({
      ...row,
      anio: row.contenedor && /^\d{2}/.test(row.contenedor)
        ? `20${row.contenedor.slice(0, 2)}`
        : null,
    }));
  
    const grouped = dfWithYear.reduce((acc, row) => {
      if (!row.anio) return acc;
      if (!acc[row.anio]) acc[row.anio] = new Set();
      acc[row.anio].add(row.contenedor.toLowerCase());
      return acc;
    }, {});
  
    const resultFrames = [];
  
    for (const [anio, contSet] of Object.entries(grouped)) {
      if (!anio) {
        console.warn("⚠️ Contenedor con año no reconocido, se omite.");
        continue;
      }
  
      const contenedores = Array.from(contSet);
      const contenedores_str = contenedores.map(c => `'${c}'`).join(', ');
  
      console.log(`📦 Año ${anio} → Contenedores: ${contenedores_str}`);
  

    const query = `
             WITH total_general AS (
                SELECT
                    grupo,
                    SUM(venta) AS venta_total,
                    SUM(cantidad_vendida) AS cantidad_vendida_total,
                    MIN(fecha_ingreso) AS fecha_ingreso_minima
                FROM colombia.analisis_por_categoria_de_producto
                WHERE anio = '${anio}' AND LOWER(contenedor) IN (${contenedores_str})

                GROUP BY grupo
            ),
            venta_global_total AS (
                SELECT SUM(venta) AS venta_total_global
                FROM colombia.analisis_por_categoria_de_producto
                WHERE anio = '${anio}' AND LOWER(contenedor) IN (${contenedores_str})

            ),
            venta_global_por_grupo AS (
                SELECT
                    grupo,
                    SUM(venta) AS venta_global
                FROM colombia.analisis_por_categoria_de_producto
                WHERE anio = '${anio}' AND LOWER(contenedor) IN (${contenedores_str})

                GROUP BY grupo
            ),
            venta_global_por_contenedor AS (
                SELECT
                    contenedor,
                    SUM(venta) AS venta_global
                FROM colombia.analisis_por_categoria_de_producto
                WHERE anio = '${anio}' AND LOWER(contenedor) IN (${contenedores_str})

                GROUP BY contenedor
            ),
            th_mov_logisticos_inventario_extra AS (
                SELECT
                    mli.clase_movimiento,
                    mli.valor,
                    mli.fecha,
                    mli.lote,
                    mli.grupo,
                    mli.producto,
                    nmm.marca,
                    nmm.grupo AS perfil_producto,
                    nmm.segmento,
                    nmm.dato5 AS material_produccion,
                    nmm.paqueteria,
                    mli.material
                FROM colombia.th_mov_logisticos_inventario mli
                LEFT JOIN colombia.nuevo_maestra_material nmm ON mli.material = nmm.material
            ),
            CompraTotal AS (
                SELECT
                    grupo,
                    SUM(valor) AS costo_total_compras
                FROM th_mov_logisticos_inventario_extra
                WHERE clase_movimiento = 'COMPRA' AND startsWith(lote, right('${anio}', 2)) AND LOWER(lote) IN (${contenedores_str})
                GROUP BY grupo
            ),
            VentasDiarias AS (
                SELECT
                    toDate(fecha) AS fecha,
                    grupo,
                    SUM(valor) AS valor_venta
                FROM th_mov_logisticos_inventario_extra
                WHERE clase_movimiento = 'VENTA' AND startsWith(lote, right('${anio}', 2)) AND LOWER(lote) IN (${contenedores_str})
                GROUP BY fecha, grupo
            ),
            VentasAcumuladas AS (
                SELECT
                    fecha,
                    grupo,
                    valor_venta,
                    SUM(valor_venta) OVER (
                        PARTITION BY grupo
                        ORDER BY fecha
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS venta_acumulada
                FROM VentasDiarias
            ),
            ROI_Calculation AS (
                SELECT
                    c.grupo,
                    c.costo_total_compras,
                    v.fecha,
                    COALESCE(v.valor_venta, 0) AS valor_venta,
                    COALESCE(v.venta_acumulada, 0) AS venta_acumulada,
                    (COALESCE(v.venta_acumulada, 0) - c.costo_total_compras) AS diferencia,
                    IF(abs(COALESCE(v.venta_acumulada, 0)) >= c.costo_total_compras, 1, 0) AS superado
                FROM CompraTotal c
                LEFT JOIN VentasAcumuladas v ON c.grupo = v.grupo
            ),
            ROI_Result AS (
                SELECT
                    grupo,
                    IF(MAX(COALESCE(superado, 0)) = 1,
                    minIf(fecha, superado = 1),
                    today()) AS fecha_roi
                FROM ROI_Calculation
                GROUP BY grupo
            )
            SELECT
                a.contenedor AS contenedor,
                a.grupo AS grupo,
                MIN(a.fecha_ingreso) AS fecha_ingreso,
                DATEDIFF('day', MIN(a.fecha_ingreso), MIN(COALESCE(r.fecha_roi, today()))) AS dias_inv,
                SUM(a.compra) AS compra,
                SUM(a.venta) AS venta,
                any(venta_global_total.venta_total_global) AS venta_total_global,
                any(vg.venta_global) AS venta_grupo,
                any(vc.venta_global) AS venta_contenedor,
                SUM(a.venta) AS total_venta,
                (SUM(a.venta) - SUM(a.compra)) / NULLIF(SUM(a.compra), 0) AS roi,
                MIN(COALESCE(r.fecha_roi, today())) AS fecha_roi,
                COALESCE(SUM(a.venta) / NULLIF(venta_total_global, 0), 0) AS porcentaje_participacion,
                COALESCE(SUM(a.venta) / NULLIF(venta_contenedor, 0), 0) AS porcentaje_participacion_relativo,
                SUM(a.cantidad_comprada) AS cantidad_comprada,
                SUM(a.cantidad_vendida) AS cantidad_vendida,
                CASE
                    WHEN SUM(a.cantidad_comprada) = 0 THEN 0
                    ELSE COALESCE(SUM(a.cantidad_vendida), 0) / NULLIF(SUM(a.cantidad_comprada), 0)
                END AS porcentaje_evacuacion,
                SUM(a.inventario_actual) AS inventario_actual,
                CASE
                    WHEN COALESCE(SUM(a.cantidad_vendida), 0) = 0 THEN 0
                    ELSE COALESCE(SUM(a.inventario_actual), 0) / 
                        NULLIF((COALESCE(SUM(a.cantidad_vendida), 0) /
                        NULLIF(DATEDIFF('day', MIN(a.fecha_ingreso), today()) / 30, 0)), 0)
                END AS miu,
                COUNT(DISTINCT a.grupo) AS quantity,
                (SUM(a.compra) / NULLIF(SUM(a.cantidad_comprada), 0)) AS unitary_cost
            FROM colombia.analisis_por_categoria_de_producto a
            LEFT JOIN total_general t ON a.grupo = t.grupo
            LEFT JOIN venta_global_total ON 1 = 1
            LEFT JOIN venta_global_por_grupo vg ON vg.grupo = a.grupo
            LEFT JOIN venta_global_por_contenedor vc ON vc.contenedor = a.contenedor
            LEFT JOIN ROI_Result r ON LOWER(a.grupo) = LOWER(r.grupo)
            WHERE anio = '${anio}' AND LOWER(contenedor) IN (${contenedores_str})
            GROUP BY a.contenedor, a.grupo
    `;
    try {
        const resultSet = await client.query({ query, format: 'JSONEachRow' });
        const rows = await resultSet.json();
        resultFrames.push(...rows);
      } catch (error) {
        console.error(`Error al ejecutar la consulta para el año ${anio}:`, error);
      }
      
    }
  
    return resultFrames;
  }

module.exports = {
  getReportData,
  getReportDataQ2,
};

// async function main() {
//     try {
//       const firstResult = await getReportData();
//       const secondResult = await getReportDataQ2(firstResult);

//     } catch (error) {
//       console.error(error);
//     }
//   }
  
//   main();
  
