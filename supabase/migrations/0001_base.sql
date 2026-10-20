-- 0001 - esquema base del panel y del bot.
--
-- Generado con pg_dump --schema-only desde la base de produccion. No se edita a
-- mano: si cambia el esquema, se vuelve a generar y va como migracion nueva.
--
-- Las extensiones van primero porque el esquema las usa: btree_gist sostiene la
-- restriccion EXCLUDE que impide dos turnos superpuestos, y unaccent lo usan las
-- funciones que traducen el nombre de usuario al correo de Supabase Auth.

create extension if not exists btree_gist with schema public;
create extension if not exists unaccent with schema public;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: buscar_cliente_por_telefono(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.buscar_cliente_por_telefono(p_telefono text) RETURNS TABLE(id integer, nombre text, telefono text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select c.id, c.nombre, t.telefono
  from telefonos t
  join clientes c on c.id = t.cliente_id
  where public.digitos(t.telefono) = public.digitos(p_telefono)
    and public.digitos(p_telefono) <> ''
  order by c.id
  limit 1;
$$;


--
-- Name: correo_de_usuario(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correo_de_usuario(p_usuario text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT coalesce(
    -- El nombre vacio, o hecho solo de simbolos ("!!!"), no tiene un correo derivable.
    -- 'usuario' es un nombre interno que nunca va a chocar con uno real. Devolver vacio
    -- seria peor: la app armaria "@carwash.local", que es un correo invalido y produce
    -- un error de GoTrue que no dice nada util.
    --
    -- `btrim(x, '-')` y no `trim(both '-' from x)`: las dos son lo mismo en Postgres,
    -- pero la segunda no pasa el parser de la migracion.
    nullif(
      btrim(
        regexp_replace(
          unaccent(lower(coalesce(trim(p_usuario), ''))),
          '[^a-z0-9]+', '-', 'g'
        ),
        '-'
      ),
      ''
    ) || '@carwash.local',
    'usuario@carwash.local'
  );
$$;


--
-- Name: FUNCTION correo_de_usuario(p_usuario text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.correo_de_usuario(p_usuario text) IS 'El correo de Supabase Auth que corresponde a un nombre de usuario. Vive en la base para que la app y la funcion de borde admin-usuarios hagan la misma cuenta.';


--
-- Name: digitos(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.digitos(t text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select coalesce(right(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 10), '');
$$;


--
-- Name: FUNCTION digitos(t text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.digitos(t text) IS 'Ultimos 10 digitos de un telefono, para comparar sin prefijo 54 ni el 9 opcional.';


--
-- Name: empleado_actual(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.empleado_actual() RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'empleado_id', '')::integer;
$$;


--
-- Name: FUNCTION empleado_actual(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.empleado_actual() IS 'El empleado_id del usuario que consulta, del app_metadata del JWT. NULL si es admin o secretario, o si es empleado sin vincular.';


--
-- Name: leer_secreto(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leer_secreto(p_nombre text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'vault'
    AS $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nombre limit 1;
$$;


--
-- Name: limpiar_tablas_bot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.limpiar_tablas_bot() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_mensajes integer := 0;
  v_recordatorios integer := 0;
begin
  -- Los mensajes ya viejos no van a ser reintentados nunca.
  delete from public.mensajes_procesados
   where processed_at < now() - interval '30 days';
  get diagnostics v_mensajes = row_count;

  -- Los recordatorios de turnos que ya pasaron. "Pasó" quiere decir más de un día:
  -- el cron corre cada 15 minutos y mira los turnos de MAÑANA, así que dejar un
  -- margen de un día asegura que jamás se borre nada que todavía sea candidato.
  delete from public.recordatorios_enviados r
   where exists (
     select 1 from public.turnos t
      where t.id = r.turno_id
        and t.fecha < (current_date - 1)
   );
  get diagnostics v_recordatorios = row_count;

  return jsonb_build_object(
    'mensajes_procesados_borrados',   v_mensajes,
    'recordatorios_enviados_borrados', v_recordatorios,
    'cuando', now()
  );
end;
$$;


--
-- Name: FUNCTION limpiar_tablas_bot(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.limpiar_tablas_bot() IS 'Borra mensajes_procesados de mas de 30 dias y recordatorios de turnos que ya no existen.';


--
-- Name: obtener_o_crear_cliente(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.obtener_o_crear_cliente(p_telefono text) RETURNS TABLE(id integer, nombre text)
    LANGUAGE plpgsql
    AS $_$
declare
  v_cliente_id int;
  v_nombre      text;
  v_contador    int;
  v_digitos     text;
begin
  v_digitos := public.digitos(p_telefono);

  -- Primero el match por digitos (ignora 54 / 9 / + / espacios).
  select t.cliente_id, c.nombre into v_cliente_id, v_nombre
  from telefonos t
  join clientes c on c.id = t.cliente_id
  where public.digitos(t.telefono) = v_digitos
    and v_digitos <> ''
  limit 1;

  -- Si no hay match pero el numero viene completo, guardar prolijo.
  if v_cliente_id is null and p_telefono is not null and length(regexp_replace(p_telefono, '\D', '', 'g')) >= 10 then
    -- El numero sale del MAXIMO del sufijo, no de count(*) + 1: si se borra un
    -- "Cliente Nuevo 3", el conteo da 5 y el siguiente seria "Cliente Nuevo 5",
    -- que ya existe, y revienta contra el indice unico de nombre.
    select coalesce(max(substring(clientes.nombre from 'Cliente Nuevo ([0-9]+)')::int), 0) + 1
      into v_contador
    from clientes
    where clientes.nombre ~ '^Cliente Nuevo [0-9]+$';

    v_nombre := 'Cliente Nuevo ' || v_contador;

    insert into clientes (nombre) values (v_nombre)
    returning clientes.id into v_cliente_id;

    insert into telefonos (cliente_id, telefono, principal)
    values (v_cliente_id, p_telefono, true);
  end if;

  return query select v_cliente_id, v_nombre;
end;
$_$;


--
-- Name: obtener_o_crear_conversacion(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.obtener_o_crear_conversacion(p_telefono text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  insert into conversaciones (telefono)
  values (p_telefono)
  on conflict (telefono) do nothing;
end;
$$;


--
-- Name: proximo_turno_libre(date, time without time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.proximo_turno_libre(p_fecha date, p_hora_inicio time without time zone, p_duracion integer) RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_fecha DATE := p_fecha;
  v_hora TIME;
  v_hora_fin TIME;
  v_solapados INT;
  v_puestos INT;
  v_hora_apertura TIME;
  v_hora_cierre TIME;
  v_dia_semana INT;
  v_intentos_dia INT := 0;
  v_diff BIGINT;
  v_antes_fecha DATE;
  v_antes_hora TIME;
  v_antes_diff BIGINT := 999999999;
  v_despues_fecha DATE;
  v_despues_hora TIME;
  v_despues_diff BIGINT := 999999999;
BEGIN
  SELECT COALESCE(CAST(valor AS INT), 1)
  INTO v_puestos
  FROM configuracion
  WHERE clave = 'puestos_por_turno';

  WHILE v_intentos_dia < 8 LOOP
    v_dia_semana := EXTRACT(DOW FROM v_fecha);

    FOR v_hora_apertura, v_hora_cierre IN
      SELECT hora_inicio, hora_fin
      FROM horarios_atencion
      WHERE dia_semana = v_dia_semana AND activo = true
      ORDER BY hora_inicio
    LOOP
      v_hora := v_hora_apertura;

      WHILE v_hora < v_hora_cierre LOOP
        v_hora_fin := v_hora + (p_duracion || ' minutes')::INTERVAL;

        IF v_hora_fin > v_hora_cierre THEN
          v_hora := v_hora + INTERVAL '15 minutes';
          CONTINUE;
        END IF;

        SELECT COUNT(*) INTO v_solapados
        FROM turnos
        WHERE fecha = v_fecha
          AND estado != 'cancelado'
          AND hora_inicio < v_hora_fin
          AND hora_fin > v_hora;

        IF v_solapados < v_puestos THEN
          v_diff := ABS(EXTRACT(EPOCH FROM (
            (v_fecha + v_hora) - (p_fecha + p_hora_inicio)
          )));

          IF v_fecha = p_fecha AND v_hora <= p_hora_inicio THEN
            IF v_diff < v_antes_diff THEN
              v_antes_diff := v_diff;
              v_antes_fecha := v_fecha;
              v_antes_hora := v_hora;
            END IF;
          ELSE
            IF v_diff < v_despues_diff THEN
              v_despues_diff := v_diff;
              v_despues_fecha := v_fecha;
              v_despues_hora := v_hora;
            END IF;
          END IF;
        END IF;

        v_hora := v_hora + INTERVAL '15 minutes';
      END LOOP;
    END LOOP;

    v_fecha := v_fecha + INTERVAL '1 day';
    v_intentos_dia := v_intentos_dia + 1;
  END LOOP;

  RETURN json_build_object(
    'opcion1', CASE WHEN v_antes_fecha IS NOT NULL
      THEN v_antes_fecha::TEXT || 'T' || v_antes_hora::TEXT
      ELSE NULL END,
    'opcion2', CASE WHEN v_despues_fecha IS NOT NULL
      THEN v_despues_fecha::TEXT || 'T' || v_despues_hora::TEXT
      ELSE NULL END
  );
END;
$$;


--
-- Name: quien_soy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.quien_soy() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 'current_user=' || current_user
      || ' | rol_activo=' || current_setting('role', true)
      || ' | jwt_rol=' || coalesce(auth.jwt() ->> 'role','(sin jwt)')
      || ' | jwt_app_rol=' || coalesce(auth.jwt() -> 'app_metadata' ->> 'rol','(sin jwt)');
$$;


--
-- Name: rol_actual(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rol_actual() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'rol', 'anonimo');
$$;


--
-- Name: FUNCTION rol_actual(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.rol_actual() IS 'El rol de quien consulta, leido del app_metadata del JWT de Supabase Auth. "anonimo" si no hay sesion.';


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: verificar_disponibilidad(date, time without time zone, time without time zone, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verificar_disponibilidad(p_fecha date, p_hora_inicio time without time zone, p_hora_fin time without time zone, p_empleado_id bigint DEFAULT NULL::bigint) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
declare
  turnos_superpuestos int;
begin
  select count(*) into turnos_superpuestos
  from turnos
  where fecha = p_fecha
    and estado <> 'cancelado'
    and hora_inicio < p_hora_fin
    and hora_fin > p_hora_inicio
    and (p_empleado_id is null or empleado_id = p_empleado_id);

  return turnos_superpuestos = 0;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ausencias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ausencias (
    id integer NOT NULL,
    empleado_id integer NOT NULL,
    desde date NOT NULL,
    hasta date,
    hora_inicio time without time zone,
    hora_fin time without time zone,
    tipo text DEFAULT 'ausencia'::text NOT NULL,
    motivo text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ausencias_horas CHECK ((((hora_inicio IS NULL) AND (hora_fin IS NULL)) OR ((hora_inicio IS NOT NULL) AND (hora_fin IS NOT NULL) AND (hora_fin > hora_inicio)))),
    CONSTRAINT ausencias_rango CHECK (((hasta IS NULL) OR (hasta >= desde)))
);


--
-- Name: TABLE ausencias; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ausencias IS 'Excepciones con fecha a la jornada semanal del empleado (vacaciones, licencias, enfermedades).';


--
-- Name: COLUMN ausencias.hasta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ausencias.hasta IS 'Fin del rango. NULL = un solo dia.';


--
-- Name: COLUMN ausencias.hora_inicio; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ausencias.hora_inicio IS 'NULL = ausencia de dia completo.';


--
-- Name: COLUMN ausencias.tipo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ausencias.tipo IS 'ausencia | vacaciones | licencia | enfermedad | permiso | otro.';


--
-- Name: ausencias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ausencias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ausencias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ausencias_id_seq OWNED BY public.ausencias.id;


--
-- Name: clientes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clientes (
    id integer NOT NULL,
    nombre text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    cuit_cuil text,
    direccion text
);


--
-- Name: COLUMN clientes.cuit_cuil; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clientes.cuit_cuil IS 'CUIT o CUIL. Opcional.';


--
-- Name: COLUMN clientes.direccion; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clientes.direccion IS 'Dirección. Opcional.';


--
-- Name: clientes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clientes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clientes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clientes_id_seq OWNED BY public.clientes.id;


--
-- Name: comisiones_empleado; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comisiones_empleado (
    id bigint NOT NULL,
    empleado_id bigint,
    servicio_id bigint,
    porcentaje integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: comisiones_empleado_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comisiones_empleado_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comisiones_empleado_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comisiones_empleado_id_seq OWNED BY public.comisiones_empleado.id;


--
-- Name: compras_proveedor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compras_proveedor (
    id integer NOT NULL,
    proveedor_id integer NOT NULL,
    fecha date NOT NULL,
    concepto text NOT NULL,
    cantidad numeric(10,2) DEFAULT 1 NOT NULL,
    monto numeric(12,2) NOT NULL,
    notas text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT compras_proveedor_cantidad_check CHECK ((cantidad > (0)::numeric)),
    CONSTRAINT compras_proveedor_monto_check CHECK ((monto > (0)::numeric))
);


--
-- Name: TABLE compras_proveedor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.compras_proveedor IS 'Compras concretas a proveedores (insumos, repuestos, servicios). El total de cada compra.';


--
-- Name: COLUMN compras_proveedor.concepto; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.compras_proveedor.concepto IS 'Descripcion libre: "12 bidones de shampoo". No es FK a un catalogo de insumos: no hay control de stock.';


--
-- Name: COLUMN compras_proveedor.monto; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.compras_proveedor.monto IS 'TOTAL de la compra, no el precio unitario.';


--
-- Name: compras_proveedor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.compras_proveedor_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: compras_proveedor_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.compras_proveedor_id_seq OWNED BY public.compras_proveedor.id;


--
-- Name: configuracion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuracion (
    id integer NOT NULL,
    clave text NOT NULL,
    valor text
);


--
-- Name: configuracion_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.configuracion_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: configuracion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.configuracion_id_seq OWNED BY public.configuracion.id;


--
-- Name: conversaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversaciones (
    id integer NOT NULL,
    telefono text NOT NULL,
    estado text DEFAULT ''::text,
    tipo text,
    servicio_id integer,
    servicio_nombre text,
    servicio_precio numeric,
    servicio_duracion integer,
    fecha_propuesta date,
    hora_propuesta time without time zone,
    fecha_propuesta_2 date,
    hora_propuesta_2 time without time zone,
    turnos_ids text,
    updated_at timestamp without time zone DEFAULT now(),
    historial_claude text,
    ultimo_error text
);


--
-- Name: COLUMN conversaciones.historial_claude; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.conversaciones.historial_claude IS 'Historial de la conversación en formato de la API de Anthropic, como JSON. Lo escribe y lee la función de borde whatsapp-bot.';


--
-- Name: conversaciones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversaciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversaciones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversaciones_id_seq OWNED BY public.conversaciones.id;


--
-- Name: dias_cerrados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dias_cerrados (
    id integer NOT NULL,
    fecha date NOT NULL,
    fecha_hasta date,
    motivo text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: COLUMN dias_cerrados.fecha_hasta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.dias_cerrados.fecha_hasta IS 'Fin del periodo. NULL = cierre de un solo dia. La app valida que no haya rangos superpuestos.';


--
-- Name: dias_cerrados_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dias_cerrados_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dias_cerrados_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dias_cerrados_id_seq OWNED BY public.dias_cerrados.id;


--
-- Name: empleados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empleados (
    id bigint NOT NULL,
    nombre text NOT NULL,
    telefono text,
    comision_porcentaje integer DEFAULT 10,
    activo boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    jornada jsonb,
    cuit_cuil text,
    direccion text
);


--
-- Name: COLUMN empleados.jornada; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.empleados.jornada IS 'Patron semanal: array de 7 slots (0=domingo ... 6=sabado), cada uno {activo, hora_inicio, hora_fin}. NULL en los horarios = sin limite (8). Reemplaza a dias_trabaja.';


--
-- Name: COLUMN empleados.cuit_cuil; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.empleados.cuit_cuil IS 'CUIT o CUIL. Opcional.';


--
-- Name: COLUMN empleados.direccion; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.empleados.direccion IS 'Dirección. Opcional.';


--
-- Name: empleados_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.empleados_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: empleados_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.empleados_id_seq OWNED BY public.empleados.id;


--
-- Name: horarios_atencion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.horarios_atencion (
    id integer NOT NULL,
    dia_semana integer NOT NULL,
    hora_inicio time without time zone NOT NULL,
    hora_fin time without time zone NOT NULL,
    activo boolean DEFAULT true
);


--
-- Name: horarios_atencion_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.horarios_atencion_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: horarios_atencion_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.horarios_atencion_id_seq OWNED BY public.horarios_atencion.id;


--
-- Name: mensajes_procesados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mensajes_procesados (
    id text NOT NULL,
    telefono text,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: metodos_pago; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metodos_pago (
    id integer NOT NULL,
    nombre text NOT NULL,
    emoji text,
    activo boolean DEFAULT true,
    orden integer DEFAULT 0
);


--
-- Name: metodos_pago_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metodos_pago_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metodos_pago_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metodos_pago_id_seq OWNED BY public.metodos_pago.id;


--
-- Name: pagos_empleado; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pagos_empleado (
    id integer NOT NULL,
    empleado_id integer NOT NULL,
    fecha date NOT NULL,
    monto numeric(12,2) NOT NULL,
    metodo text DEFAULT 'efectivo'::text NOT NULL,
    notas text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pagos_empleado_monto_check CHECK ((monto > (0)::numeric))
);


--
-- Name: TABLE pagos_empleado; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pagos_empleado IS 'Pagos REALES a empleados. La caja los compara contra el calculo de comisiones para mostrar la diferencia.';


--
-- Name: COLUMN pagos_empleado.monto; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pagos_empleado.monto IS 'Cuanto se le dio, en la moneda del negocio. Guardar el monto y no el % para que cambiar el precio de un turno viejo no altere un pago ya hecho.';


--
-- Name: COLUMN pagos_empleado.metodo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pagos_empleado.metodo IS 'efectivo | transferencia | otro. Texto y no FK a proposito.';


--
-- Name: pagos_empleado_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pagos_empleado_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pagos_empleado_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pagos_empleado_id_seq OWNED BY public.pagos_empleado.id;


--
-- Name: pagos_proveedor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pagos_proveedor (
    id integer NOT NULL,
    proveedor_id integer NOT NULL,
    fecha date NOT NULL,
    monto numeric(12,2) NOT NULL,
    compra_id integer,
    metodo text DEFAULT 'transferencia'::text NOT NULL,
    notas text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pagos_proveedor_monto_check CHECK ((monto > (0)::numeric))
);


--
-- Name: TABLE pagos_proveedor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pagos_proveedor IS 'Abonos REALES a proveedores. Varios por compra: a los proveedores se les paga por partes.';


--
-- Name: COLUMN pagos_proveedor.monto; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pagos_proveedor.monto IS 'Cuanto se abono, en la moneda del negocio. Guardar el monto y no un porcentaje para que cambiar el precio de un insumo no altere un abono ya hecho.';


--
-- Name: COLUMN pagos_proveedor.compra_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pagos_proveedor.compra_id IS 'Compra a la que se imputa el abono. NULL = pago a cuenta o saldo de una compra vieja.';


--
-- Name: COLUMN pagos_proveedor.metodo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pagos_proveedor.metodo IS 'efectivo | transferencia | otro. Texto y no FK a proposito.';


--
-- Name: pagos_proveedor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pagos_proveedor_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pagos_proveedor_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pagos_proveedor_id_seq OWNED BY public.pagos_proveedor.id;


--
-- Name: proveedores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proveedores (
    id integer NOT NULL,
    nombre text NOT NULL,
    contacto text,
    telefono text,
    notas text,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    domicilio text,
    cuit_cuil text
);


--
-- Name: TABLE proveedores; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.proveedores IS 'De quien se compra (arquitectos, mayoristas, etc). Modelo igual a clientes: inactivar, no borrar.';


--
-- Name: COLUMN proveedores.domicilio; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proveedores.domicilio IS 'Direccion del proveedor. NULL = no lo sabemos: la app muestra un guion medio en vez de un hueco vacio.';


--
-- Name: COLUMN proveedores.cuit_cuil; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proveedores.cuit_cuil IS 'CUIT o CUIL. Opcional.';


--
-- Name: proveedores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proveedores_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proveedores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proveedores_id_seq OWNED BY public.proveedores.id;


--
-- Name: recordatorios_enviados; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recordatorios_enviados (
    id integer NOT NULL,
    turno_id integer NOT NULL,
    telefono text,
    enviado_at timestamp with time zone DEFAULT now() NOT NULL,
    exito boolean DEFAULT true NOT NULL,
    detalle text
);


--
-- Name: TABLE recordatorios_enviados; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recordatorios_enviados IS 'Que turnos ya recibieron su recordatorio. El unique en turno_id evita el duplicado.';


--
-- Name: recordatorios_enviados_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recordatorios_enviados_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recordatorios_enviados_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recordatorios_enviados_id_seq OWNED BY public.recordatorios_enviados.id;


--
-- Name: servicios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servicios (
    id integer NOT NULL,
    nombre text NOT NULL,
    precio numeric NOT NULL,
    duracion_minutos integer NOT NULL,
    activo boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: servicios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.servicios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: servicios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.servicios_id_seq OWNED BY public.servicios.id;


--
-- Name: telefonos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telefonos (
    id integer NOT NULL,
    cliente_id integer,
    telefono text NOT NULL,
    principal boolean DEFAULT false
);


--
-- Name: telefonos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.telefonos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: telefonos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.telefonos_id_seq OWNED BY public.telefonos.id;


--
-- Name: turnos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turnos (
    id integer NOT NULL,
    cliente_id integer,
    cliente_nombre text,
    cliente_telefono text,
    fecha date NOT NULL,
    hora time without time zone,
    hora_inicio time without time zone,
    hora_fin time without time zone,
    servicio_id integer,
    servicio_nombre text,
    precio numeric,
    duracion_minutos integer,
    estado text DEFAULT 'pendiente'::text,
    created_at timestamp without time zone DEFAULT now(),
    metodo_pago text,
    precio_final numeric,
    observaciones text,
    servicio_nombre_final text,
    empleado_id bigint,
    servicio_id_final integer,
    CONSTRAINT turnos_hora_coincide CHECK (((hora_inicio IS NULL) OR (hora = hora_inicio)))
);


--
-- Name: COLUMN turnos.cliente_telefono; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turnos.cliente_telefono IS 'SNAPSHOT del telefono al tomar el turno. La UI debe leer telefonos (telefonoDe), no este campo. NULL = sin telefono.';


--
-- Name: COLUMN turnos.hora; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turnos.hora IS 'Duplicada de hora_inicio. Las dos se escriben siempre juntas (ver CHECK turnos_hora_coincide). Candidata a borrar: la app ya lee hora_inicio y solo usa esta para ordenar.';


--
-- Name: COLUMN turnos.precio_final; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turnos.precio_final IS 'Precio realmente cobrado. NULL = se cobro el precio reservado.';


--
-- Name: COLUMN turnos.servicio_nombre_final; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turnos.servicio_nombre_final IS 'Nombre del servicio cobrado. Snapshot: sobrevive al borrado del servicio.';


--
-- Name: COLUMN turnos.servicio_id_final; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.turnos.servicio_id_final IS 'Servicio realmente cobrado (FK logica a servicios, sin constraint a proposito: es un snapshot historico). NULL = se cobro lo que se reservo.';


--
-- Name: turnos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.turnos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: turnos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.turnos_id_seq OWNED BY public.turnos.id;


--
-- Name: usuarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuarios (
    id integer NOT NULL,
    usuario text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    rol text NOT NULL,
    empleado_id integer,
    CONSTRAINT usuarios_rol_check CHECK ((rol = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])))
);


--
-- Name: COLUMN usuarios.rol; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.usuarios.rol IS 'admin: ve y modifica todo. secretario: ve todo pero no escribe en Caja. empleado: solo Turnos y Agenda, y unicamente sus propios turnos.';


--
-- Name: COLUMN usuarios.empleado_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.usuarios.empleado_id IS 'Empleado al que pertenece este usuario. NULL = usuario sin vincular.';


--
-- Name: usuarios_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.usuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: usuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.usuarios_id_seq OWNED BY public.usuarios.id;


--
-- Name: ausencias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ausencias ALTER COLUMN id SET DEFAULT nextval('public.ausencias_id_seq'::regclass);


--
-- Name: clientes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes ALTER COLUMN id SET DEFAULT nextval('public.clientes_id_seq'::regclass);


--
-- Name: comisiones_empleado id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comisiones_empleado ALTER COLUMN id SET DEFAULT nextval('public.comisiones_empleado_id_seq'::regclass);


--
-- Name: compras_proveedor id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compras_proveedor ALTER COLUMN id SET DEFAULT nextval('public.compras_proveedor_id_seq'::regclass);


--
-- Name: configuracion id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion ALTER COLUMN id SET DEFAULT nextval('public.configuracion_id_seq'::regclass);


--
-- Name: conversaciones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversaciones ALTER COLUMN id SET DEFAULT nextval('public.conversaciones_id_seq'::regclass);


--
-- Name: dias_cerrados id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dias_cerrados ALTER COLUMN id SET DEFAULT nextval('public.dias_cerrados_id_seq'::regclass);


--
-- Name: empleados id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleados ALTER COLUMN id SET DEFAULT nextval('public.empleados_id_seq'::regclass);


--
-- Name: horarios_atencion id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.horarios_atencion ALTER COLUMN id SET DEFAULT nextval('public.horarios_atencion_id_seq'::regclass);


--
-- Name: metodos_pago id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodos_pago ALTER COLUMN id SET DEFAULT nextval('public.metodos_pago_id_seq'::regclass);


--
-- Name: pagos_empleado id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_empleado ALTER COLUMN id SET DEFAULT nextval('public.pagos_empleado_id_seq'::regclass);


--
-- Name: pagos_proveedor id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_proveedor ALTER COLUMN id SET DEFAULT nextval('public.pagos_proveedor_id_seq'::regclass);


--
-- Name: proveedores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores ALTER COLUMN id SET DEFAULT nextval('public.proveedores_id_seq'::regclass);


--
-- Name: recordatorios_enviados id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordatorios_enviados ALTER COLUMN id SET DEFAULT nextval('public.recordatorios_enviados_id_seq'::regclass);


--
-- Name: servicios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servicios ALTER COLUMN id SET DEFAULT nextval('public.servicios_id_seq'::regclass);


--
-- Name: telefonos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telefonos ALTER COLUMN id SET DEFAULT nextval('public.telefonos_id_seq'::regclass);


--
-- Name: turnos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos ALTER COLUMN id SET DEFAULT nextval('public.turnos_id_seq'::regclass);


--
-- Name: usuarios id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id SET DEFAULT nextval('public.usuarios_id_seq'::regclass);


--
-- Name: ausencias ausencias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ausencias
    ADD CONSTRAINT ausencias_pkey PRIMARY KEY (id);


--
-- Name: clientes clientes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clientes
    ADD CONSTRAINT clientes_pkey PRIMARY KEY (id);


--
-- Name: comisiones_empleado comisiones_empleado_empleado_id_servicio_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comisiones_empleado
    ADD CONSTRAINT comisiones_empleado_empleado_id_servicio_id_key UNIQUE (empleado_id, servicio_id);


--
-- Name: comisiones_empleado comisiones_empleado_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comisiones_empleado
    ADD CONSTRAINT comisiones_empleado_pkey PRIMARY KEY (id);


--
-- Name: compras_proveedor compras_proveedor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compras_proveedor
    ADD CONSTRAINT compras_proveedor_pkey PRIMARY KEY (id);


--
-- Name: configuracion configuracion_clave_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion
    ADD CONSTRAINT configuracion_clave_key UNIQUE (clave);


--
-- Name: configuracion configuracion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracion
    ADD CONSTRAINT configuracion_pkey PRIMARY KEY (id);


--
-- Name: conversaciones conversaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversaciones
    ADD CONSTRAINT conversaciones_pkey PRIMARY KEY (id);


--
-- Name: conversaciones conversaciones_telefono_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversaciones
    ADD CONSTRAINT conversaciones_telefono_key UNIQUE (telefono);


--
-- Name: dias_cerrados dias_cerrados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dias_cerrados
    ADD CONSTRAINT dias_cerrados_pkey PRIMARY KEY (id);


--
-- Name: empleados empleados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empleados
    ADD CONSTRAINT empleados_pkey PRIMARY KEY (id);


--
-- Name: horarios_atencion horarios_atencion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.horarios_atencion
    ADD CONSTRAINT horarios_atencion_pkey PRIMARY KEY (id);


--
-- Name: mensajes_procesados mensajes_procesados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mensajes_procesados
    ADD CONSTRAINT mensajes_procesados_pkey PRIMARY KEY (id);


--
-- Name: metodos_pago metodos_pago_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metodos_pago
    ADD CONSTRAINT metodos_pago_pkey PRIMARY KEY (id);


--
-- Name: pagos_empleado pagos_empleado_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_empleado
    ADD CONSTRAINT pagos_empleado_pkey PRIMARY KEY (id);


--
-- Name: pagos_proveedor pagos_proveedor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_proveedor
    ADD CONSTRAINT pagos_proveedor_pkey PRIMARY KEY (id);


--
-- Name: proveedores proveedores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proveedores
    ADD CONSTRAINT proveedores_pkey PRIMARY KEY (id);


--
-- Name: recordatorios_enviados recordatorios_enviados_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordatorios_enviados
    ADD CONSTRAINT recordatorios_enviados_pkey PRIMARY KEY (id);


--
-- Name: recordatorios_enviados recordatorios_enviados_turno_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordatorios_enviados
    ADD CONSTRAINT recordatorios_enviados_turno_id_key UNIQUE (turno_id);


--
-- Name: servicios servicios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servicios
    ADD CONSTRAINT servicios_pkey PRIMARY KEY (id);


--
-- Name: telefonos telefonos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telefonos
    ADD CONSTRAINT telefonos_pkey PRIMARY KEY (id);


--
-- Name: turnos turnos_empleado_no_se_pisan; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos
    ADD CONSTRAINT turnos_empleado_no_se_pisan EXCLUDE USING gist (empleado_id WITH =, tsrange(((fecha)::timestamp without time zone + (hora_inicio)::interval), ((fecha)::timestamp without time zone + (hora_fin)::interval), '[)'::text) WITH &&) WHERE ((estado <> 'cancelado'::text));


--
-- Name: CONSTRAINT turnos_empleado_no_se_pisan ON turnos; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT turnos_empleado_no_se_pisan ON public.turnos IS 'Un empleado no puede tener dos turnos que se pisen. Evita la doble reserva venga de donde venga (bot o app).';


--
-- Name: turnos turnos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos
    ADD CONSTRAINT turnos_pkey PRIMARY KEY (id);


--
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);


--
-- Name: usuarios usuarios_usuario_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_usuario_key UNIQUE (usuario);


--
-- Name: ausencias_emp_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ausencias_emp_fecha ON public.ausencias USING btree (empleado_id, desde, hasta);


--
-- Name: clientes_nombre_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX clientes_nombre_unico ON public.clientes USING btree (lower(btrim(nombre)));


--
-- Name: compras_proveedor_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX compras_proveedor_fecha ON public.compras_proveedor USING btree (fecha);


--
-- Name: compras_proveedor_prov_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX compras_proveedor_prov_fecha ON public.compras_proveedor USING btree (proveedor_id, fecha);


--
-- Name: empleados_nombre_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX empleados_nombre_unico ON public.empleados USING btree (lower(btrim(nombre)));


--
-- Name: idx_comisiones_empleado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comisiones_empleado ON public.comisiones_empleado USING btree (empleado_id);


--
-- Name: idx_mensajes_procesados_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mensajes_procesados_fecha ON public.mensajes_procesados USING btree (processed_at);


--
-- Name: idx_recordatorios_enviados_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recordatorios_enviados_fecha ON public.recordatorios_enviados USING btree (enviado_at DESC);


--
-- Name: idx_turnos_empleado; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_turnos_empleado ON public.turnos USING btree (empleado_id);


--
-- Name: idx_turnos_estado_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_turnos_estado_fecha ON public.turnos USING btree (estado, fecha);


--
-- Name: idx_turnos_fecha_hora; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_turnos_fecha_hora ON public.turnos USING btree (fecha, hora);


--
-- Name: metodos_pago_nombre_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX metodos_pago_nombre_unico ON public.metodos_pago USING btree (lower(btrim(nombre)));


--
-- Name: pagos_empleado_emp_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pagos_empleado_emp_fecha ON public.pagos_empleado USING btree (empleado_id, fecha);


--
-- Name: pagos_empleado_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pagos_empleado_fecha ON public.pagos_empleado USING btree (fecha);


--
-- Name: pagos_proveedor_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pagos_proveedor_fecha ON public.pagos_proveedor USING btree (fecha);


--
-- Name: pagos_proveedor_prov_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pagos_proveedor_prov_fecha ON public.pagos_proveedor USING btree (proveedor_id, fecha);


--
-- Name: proveedores_activo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proveedores_activo ON public.proveedores USING btree (activo);


--
-- Name: proveedores_nombre_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX proveedores_nombre_unico ON public.proveedores USING btree (lower(btrim(nombre)));


--
-- Name: servicios_nombre_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX servicios_nombre_unico ON public.servicios USING btree (lower(btrim(nombre))) WHERE (nombre IS NOT NULL);


--
-- Name: usuarios_empleado_unico; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX usuarios_empleado_unico ON public.usuarios USING btree (empleado_id) WHERE (empleado_id IS NOT NULL);


--
-- Name: conversaciones conversaciones_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER conversaciones_updated_at BEFORE UPDATE ON public.conversaciones FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: ausencias ausencias_empleado_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ausencias
    ADD CONSTRAINT ausencias_empleado_id_fkey FOREIGN KEY (empleado_id) REFERENCES public.empleados(id) ON DELETE CASCADE;


--
-- Name: comisiones_empleado comisiones_empleado_empleado_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comisiones_empleado
    ADD CONSTRAINT comisiones_empleado_empleado_id_fkey FOREIGN KEY (empleado_id) REFERENCES public.empleados(id) ON DELETE CASCADE;


--
-- Name: comisiones_empleado comisiones_empleado_servicio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comisiones_empleado
    ADD CONSTRAINT comisiones_empleado_servicio_id_fkey FOREIGN KEY (servicio_id) REFERENCES public.servicios(id) ON DELETE CASCADE;


--
-- Name: compras_proveedor compras_proveedor_proveedor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compras_proveedor
    ADD CONSTRAINT compras_proveedor_proveedor_id_fkey FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE CASCADE;


--
-- Name: pagos_empleado pagos_empleado_empleado_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_empleado
    ADD CONSTRAINT pagos_empleado_empleado_id_fkey FOREIGN KEY (empleado_id) REFERENCES public.empleados(id) ON DELETE CASCADE;


--
-- Name: pagos_proveedor pagos_proveedor_compra_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_proveedor
    ADD CONSTRAINT pagos_proveedor_compra_id_fkey FOREIGN KEY (compra_id) REFERENCES public.compras_proveedor(id) ON DELETE SET NULL;


--
-- Name: pagos_proveedor pagos_proveedor_proveedor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pagos_proveedor
    ADD CONSTRAINT pagos_proveedor_proveedor_id_fkey FOREIGN KEY (proveedor_id) REFERENCES public.proveedores(id) ON DELETE CASCADE;


--
-- Name: recordatorios_enviados recordatorios_enviados_turno_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recordatorios_enviados
    ADD CONSTRAINT recordatorios_enviados_turno_id_fkey FOREIGN KEY (turno_id) REFERENCES public.turnos(id) ON DELETE CASCADE;


--
-- Name: telefonos telefonos_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telefonos
    ADD CONSTRAINT telefonos_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id);


--
-- Name: turnos turnos_cliente_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos
    ADD CONSTRAINT turnos_cliente_id_fkey FOREIGN KEY (cliente_id) REFERENCES public.clientes(id);


--
-- Name: turnos turnos_empleado_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos
    ADD CONSTRAINT turnos_empleado_id_fkey FOREIGN KEY (empleado_id) REFERENCES public.empleados(id);


--
-- Name: turnos turnos_servicio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turnos
    ADD CONSTRAINT turnos_servicio_id_fkey FOREIGN KEY (servicio_id) REFERENCES public.servicios(id);


--
-- Name: usuarios usuarios_empleado_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_empleado_id_fkey FOREIGN KEY (empleado_id) REFERENCES public.empleados(id) ON DELETE SET NULL;


--
-- Name: ausencias; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ausencias ENABLE ROW LEVEL SECURITY;

--
-- Name: ausencias ausencias_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ausencias_borrar ON public.ausencias FOR DELETE TO authenticated USING (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual()))));


--
-- Name: ausencias ausencias_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ausencias_crear ON public.ausencias FOR INSERT TO authenticated WITH CHECK (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual()))));


--
-- Name: ausencias ausencias_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ausencias_editar ON public.ausencias FOR UPDATE TO authenticated USING (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual())))) WITH CHECK (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual()))));


--
-- Name: ausencias ausencias_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ausencias_leer ON public.ausencias FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: clientes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;

--
-- Name: clientes clientes_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clientes_borrar ON public.clientes FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: clientes clientes_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clientes_crear ON public.clientes FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: clientes clientes_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clientes_editar ON public.clientes FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: clientes clientes_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clientes_leer ON public.clientes FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: comisiones_empleado; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.comisiones_empleado ENABLE ROW LEVEL SECURITY;

--
-- Name: comisiones_empleado comisiones_empleado_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comisiones_empleado_borrar ON public.comisiones_empleado FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: comisiones_empleado comisiones_empleado_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comisiones_empleado_crear ON public.comisiones_empleado FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: comisiones_empleado comisiones_empleado_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comisiones_empleado_editar ON public.comisiones_empleado FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: comisiones_empleado comisiones_empleado_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY comisiones_empleado_leer ON public.comisiones_empleado FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: compras_proveedor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.compras_proveedor ENABLE ROW LEVEL SECURITY;

--
-- Name: compras_proveedor compras_proveedor_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compras_proveedor_borrar ON public.compras_proveedor FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: compras_proveedor compras_proveedor_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compras_proveedor_crear ON public.compras_proveedor FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: compras_proveedor compras_proveedor_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compras_proveedor_editar ON public.compras_proveedor FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: compras_proveedor compras_proveedor_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compras_proveedor_leer ON public.compras_proveedor FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: configuracion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.configuracion ENABLE ROW LEVEL SECURITY;

--
-- Name: configuracion configuracion_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuracion_borrar ON public.configuracion FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: configuracion configuracion_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuracion_crear ON public.configuracion FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: configuracion configuracion_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuracion_editar ON public.configuracion FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: configuracion configuracion_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuracion_leer ON public.configuracion FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: configuracion configuracion_leer_sin_sesion; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY configuracion_leer_sin_sesion ON public.configuracion FOR SELECT TO authenticated, anon USING (true);


--
-- Name: conversaciones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversaciones ENABLE ROW LEVEL SECURITY;

--
-- Name: dias_cerrados; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dias_cerrados ENABLE ROW LEVEL SECURITY;

--
-- Name: dias_cerrados dias_cerrados_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dias_cerrados_borrar ON public.dias_cerrados FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: dias_cerrados dias_cerrados_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dias_cerrados_crear ON public.dias_cerrados FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: dias_cerrados dias_cerrados_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dias_cerrados_editar ON public.dias_cerrados FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: dias_cerrados dias_cerrados_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dias_cerrados_leer ON public.dias_cerrados FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: empleados; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.empleados ENABLE ROW LEVEL SECURITY;

--
-- Name: empleados empleados_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY empleados_borrar ON public.empleados FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: empleados empleados_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY empleados_crear ON public.empleados FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: empleados empleados_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY empleados_editar ON public.empleados FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: empleados empleados_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY empleados_leer ON public.empleados FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: horarios_atencion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.horarios_atencion ENABLE ROW LEVEL SECURITY;

--
-- Name: horarios_atencion horarios_atencion_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY horarios_atencion_borrar ON public.horarios_atencion FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: horarios_atencion horarios_atencion_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY horarios_atencion_crear ON public.horarios_atencion FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: horarios_atencion horarios_atencion_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY horarios_atencion_editar ON public.horarios_atencion FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: horarios_atencion horarios_atencion_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY horarios_atencion_leer ON public.horarios_atencion FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: mensajes_procesados; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mensajes_procesados ENABLE ROW LEVEL SECURITY;

--
-- Name: metodos_pago; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.metodos_pago ENABLE ROW LEVEL SECURITY;

--
-- Name: metodos_pago metodos_pago_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY metodos_pago_borrar ON public.metodos_pago FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: metodos_pago metodos_pago_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY metodos_pago_crear ON public.metodos_pago FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: metodos_pago metodos_pago_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY metodos_pago_editar ON public.metodos_pago FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: metodos_pago metodos_pago_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY metodos_pago_leer ON public.metodos_pago FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: pagos_empleado; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pagos_empleado ENABLE ROW LEVEL SECURITY;

--
-- Name: pagos_empleado pagos_empleado_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_empleado_borrar ON public.pagos_empleado FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_empleado pagos_empleado_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_empleado_crear ON public.pagos_empleado FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_empleado pagos_empleado_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_empleado_editar ON public.pagos_empleado FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_empleado pagos_empleado_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_empleado_leer ON public.pagos_empleado FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: pagos_proveedor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pagos_proveedor ENABLE ROW LEVEL SECURITY;

--
-- Name: pagos_proveedor pagos_proveedor_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_proveedor_borrar ON public.pagos_proveedor FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_proveedor pagos_proveedor_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_proveedor_crear ON public.pagos_proveedor FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_proveedor pagos_proveedor_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_proveedor_editar ON public.pagos_proveedor FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: pagos_proveedor pagos_proveedor_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pagos_proveedor_leer ON public.pagos_proveedor FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: proveedores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proveedores ENABLE ROW LEVEL SECURITY;

--
-- Name: proveedores proveedores_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY proveedores_borrar ON public.proveedores FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: proveedores proveedores_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY proveedores_crear ON public.proveedores FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: proveedores proveedores_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY proveedores_editar ON public.proveedores FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: proveedores proveedores_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY proveedores_leer ON public.proveedores FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: recordatorios_enviados; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recordatorios_enviados ENABLE ROW LEVEL SECURITY;

--
-- Name: conversaciones service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all ON public.conversaciones USING (true);


--
-- Name: servicios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.servicios ENABLE ROW LEVEL SECURITY;

--
-- Name: servicios servicios_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY servicios_borrar ON public.servicios FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: servicios servicios_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY servicios_crear ON public.servicios FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: servicios servicios_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY servicios_editar ON public.servicios FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: servicios servicios_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY servicios_leer ON public.servicios FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: telefonos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telefonos ENABLE ROW LEVEL SECURITY;

--
-- Name: telefonos telefonos_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telefonos_borrar ON public.telefonos FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: telefonos telefonos_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telefonos_crear ON public.telefonos FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: telefonos telefonos_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telefonos_editar ON public.telefonos FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- Name: telefonos telefonos_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY telefonos_leer ON public.telefonos FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: turnos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.turnos ENABLE ROW LEVEL SECURITY;

--
-- Name: turnos turnos_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY turnos_borrar ON public.turnos FOR DELETE TO authenticated USING (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual()))));


--
-- Name: turnos turnos_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY turnos_crear ON public.turnos FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: turnos turnos_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY turnos_editar ON public.turnos FOR UPDATE TO authenticated USING (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual())))) WITH CHECK (((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])) OR ((public.rol_actual() = 'empleado'::text) AND (public.empleado_actual() IS NOT NULL) AND (empleado_id = public.empleado_actual()))));


--
-- Name: turnos turnos_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY turnos_leer ON public.turnos FOR SELECT TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text, 'empleado'::text])));


--
-- Name: usuarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;

--
-- Name: usuarios usuarios_borrar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usuarios_borrar ON public.usuarios FOR DELETE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: usuarios usuarios_crear; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usuarios_crear ON public.usuarios FOR INSERT TO authenticated WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: usuarios usuarios_editar; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usuarios_editar ON public.usuarios FOR UPDATE TO authenticated USING ((public.rol_actual() = ANY (ARRAY['admin'::text]))) WITH CHECK ((public.rol_actual() = ANY (ARRAY['admin'::text])));


--
-- Name: usuarios usuarios_leer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usuarios_leer ON public.usuarios FOR SELECT USING ((public.rol_actual() = ANY (ARRAY['admin'::text, 'secretario'::text])));


--
-- PostgreSQL database dump complete
--


