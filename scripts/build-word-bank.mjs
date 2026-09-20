/**
 * Arma backend/src/word-bank.json: más de 1250 palabras fáciles en español.
 * Se corre a mano si hay que regenerar el banco.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW = `
tomate plátano naranja sandía fresa manzana chocolate aguacate guacamole
cacahuate barbacoa quesadilla tortilla elote tamal mariposa pelota globo
guitarra piano zapato sombrero ventana tesoro conejo caballo paloma ballena
pingüino burbuja chapulín ajolote maracuyá cucaracha galleta moño perro gato
vaca cerdo oveja cabra burro mula ratón ardilla nutria foca lobo zorro oso
puma lince tigre león jaguar pantera elefante jirafa cebra camello llama
ciervo venado alce reno jabalí mapache tejón hurón koala canguro castor
armadillo tapir mono gorila lémur perezoso águila halcón búho lechuza loro
perico canario gorrión paloma cuervo urraca cisne pato ganso gallina gallo
pavo colibrí tucán pelícano gaviota flamenco cigüeña garza avestruz kiwi
cotorra jilguero mirlo tordo cardenal tiburón delfín orca pulpo calamar
medusa cangrejo langosta camarón ostión almeja trucha salmón atún sardina
bacalao róbalo mojarra tilapia carpa abeja avispa hormiga mosca mosquito
araña grillo cigarra libélula mariquita oruga gusano lombriz caracol babosa
alacrán papaya mango piña coco uva limón lima toronja durazno chabacano
ciruela pera melon kiwi higo dátil nuez almendra avellana pistache castaña
arándano frambuesa zarzamora mora cereza guayaba mamey tuna jícama nopal
chayote calabaza zanahoria papa camote cebolla ajo puerro apio lechuga
espinaca acelga brócoli coliflor repollo berenjena pepino chile pimiento
jitomate ejote chícharo lenteja frijol garbanzo soya arroz trigo avena
maíz cebada centeno quinoa pasta pan bolillo baguette tostada galleta
pastel pay flan gelatina nieve helado paleta churro dona muffin croissant
yogur queso crema mantequilla leche jocoque requesón ricotta mozzarella
jamón tocino chorizo salchicha longaniza pollo pavo res cerdo pescado
atún sardina camarón pulpo calamar ostión sopa caldo consomé pozole
menudo mole pipián adobo salsa pico guacamole pico guacamole
arroz frijoles nopales rajas elote esquite tostada sope huarache
gordita chalupa enchilada burrito taco tostada flauta taquito quesadilla
sopes tlacoyo memela pambazo cemita torta sandwich hamburger pizza
lasagna espagueti ravioles ñoquis risotto paella empanada pastelito
brownie galleta galleta
casa hogar cuarto sala cocina comedor recámara baño patio jardín terraza
balcón azotea sótano ático pasillo escalera elevador puerta ventana muro
pared techo piso suelo alfombra tapete cortina persiana sofá silla mesa
banco taburete cama catre litera colchón almohada cobija sábana edredón
frazada clóset cajón estante librero vitrina aparador buró escritorio
lámpara linterna velador foco bombilla veladora vela espejo cuadro reloj
calendario florero maceta planta cactus helecho orquídea rosa tulipán
girasol margarita clavel jazmín lavanda albahaca menta romero tomillo
perejil cilantro epazote orégano laurel canela vainilla clavo pimienta
comino anís azafrán jengibre cúrcuma nuez
camisa blusa playera suéter chamarra chaqueta saco abrigo gabardina
impermeable chaleco pantalón jeans short falda vestido overol pijama
bata calcetín media calceta zapato bota tenis sandalia huarache chancla
pantufla zapatilla sombrero gorra boina gorro bufanda chalina pañuelo
guante mitón cinturón corbata moño broche hebilla collar pulsera anillo
arete reloj lentes gafas sol
cabeza cara frente sien sien sien sien sien sien sien sien sien sien sien
cabello pelo ceja pestaña ojo nariz mejilla boca labio diente muela
lengua encía mentón barba bigote cuello hombro brazo codo muñeca mano
dedo palma uña pecho espalda cintura cadera pierna rodilla tobillo pie
talón planta talón talón
sol luna estrella nube cielo aurora ocaso alba atardecer mediodía
noche madrugada mañana tarde invierno primavera verano otoño lluvia
llovizna tormenta trueno relámpago rayo granizo nieve hielo escarcha
viento brisa vendaval huracán tornado ciclón neblina niebla rocío
arcoíris calor frío tibio fresco humedad sequía sequía
río lago laguna mar océano playa costa acantilado isla islote península
bahía golfo estrecho canal arroyo cascada manantial pozo fuente pantano
selva bosque bosque bosque bosque bosque bosque bosque bosque bosque
selva jungla pradera prado campo milpa huerto granja rancho establo
corral gallinero palomar colmena apiario
ciudad pueblo villa barrio colonia calle avenida calzada andador
pasaje callejón plaza jardín parque kiosco mercado tienda comercio
farmacia hospital clínica consultorio escuela colegio universidad
biblioteca museo teatro cine estadio arena gimnasio alberca piscina
cancha campo pista velódromo
lápiz pluma bolígrafo marcador crayola gis tiza goma regla escuadra
compás transportador cuaderno libreta libro revista periódico diario
diccionario atlas mapa globo pizarra pizarrón pantalla teclado ratón
computadora tablet celular teléfono auricular audífono micrófono
cámara radio televisor control consola videojuego
pelota balón raqueta bate palo red portería canasta aro gol punto
partido juego torneo liga copa medalla trofeo premio diploma
fútbol basquetbol voleibol béisbol tenis golf boxeo judo karate
natación atletismo ciclismo patinaje surf ski snowboard
coche auto camión camioneta van taxi autobús tren metro tranvía
bicicleta moto patineta monopatín barco lancha yate velero buque
avión jet helicóptero globo nave cohete satélite
martillo clavo tornillo tuerca destornillador llave alicate pinza
sierra taladro nivel cinta metro plomada pala pico azadón rastrillo
manguera cubeta balde tina cubeta
médico doctora enfermera maestro maestra alumno alumna estudiante
ingeniero abogado juez policía bombero piloto capitán marinero
cocinero mesero cajero vendedor campesino pastor minero albañil
carpintero plomero electricista pintor músico cantante actor actriz
bailarín pintora escultor poeta escritor periodista fotógrafo
papá mamá padre madre hijo hija hermano hermana abuelo abuela
tío tía primo prima sobrino sobrina nieto nieta esposo esposa
novio novia amigo amiga vecino vecina
rojo azul verde amarillo naranja morado rosa blanco negro gris
café beige crema oro plata bronce
uno dos tres cuatro cinco seis siete ocho nueve diez once doce
lunes martes miércoles jueves viernes sábado domingo
enero febrero marzo abril mayo junio julio agosto septiembre
octubre noviembre diciembre
correr saltar bailar cantar hablar comer beber dormir soñar
pensar mirar ver oír escuchar tocar oler gustar amar querer
jugar reír llorar sonreír gritar susurrar leer escribir dibujar
pintar recortar pegar armar construir abrir cerrar subir bajar
entrar salir llegar partir viajar caminar nadar volar manejar
conducir frenar acelerar girar doblar empujar jalar cargar
llevar traer dar recibir comprar vender pagar cobrar guardar
buscar encontrar perder ganar empezar terminar seguir esperar
ayudar cuidar enseñar aprender estudiar trabajar descansar
cocinar hornear freír asar hervir mezclar batir cortar picar
lavar secar planchar barrer trapear sacudir doblar guardar
cepillar peinar afeitar bañar duchar vestir calzar abrochar
abrazar besar saludar despedir invitar visitar esperar
plato vaso taza jarra olla sartén cazuela comal olla olla
cuchara tenedor cuchillo servilleta mantel tapete mantel
estufa horno microondas licuadora tostador cafetera tetera
refrigerador freezer lavadora secadora plancha aspiradora
jabón shampoo pasta cepillo toalla esponja peine secador
papel basura bote bolsa caja paquete sobre carta postal
llave candado cerradura pestillo timbre campana alarma
dinero moneda billete tarjeta cartera monedero bolsa
boleto ticket pasaporte visa visa visa visa
plaza banco iglesia templo capilla catedral convento
oficina fábrica taller almacén bodega silo granero
puente túnel carretera carretera carretera carretera
semáforo cruce esquina banqueta acera rampa
bosque pino abeto cedro encino roble álamo sauce
fresno ciprés palma bambú helecho musgo hiedra
lirio dalia begonia violeta hortensia gardenia
nube polvo humo ceniza barro lodo arena grava
piedra roca peñasco peñón cristal cuarzo mármol
oro plata cobre hierro acero aluminio estaño
vidrio plástico cartón madera tela lana algodón
seda lino cuero gamuza terciopelo encaje
agua fuego tierra aire luz sombra calor frío
dulce salado amargo ácido picante suave duro
blando tibio fresco seco húmedo limpio sucio
nuevo viejo joven adulto niño niña bebé
alto bajo gordo flaco grande pequeño mediano
largo corto ancho estrecho grueso delgado
rápido lento cerca lejos dentro fuera
arriba abajo adelante atrás izquierda derecha
primero segundo tercero último único
feliz triste enojo miedo sorpresa calma
amor odio duda fe esperanza alegría
paz guerra juego pelea abrazo
escuela clase grado salón patio recreo
tarea examen prueba ensayo proyecto
nota calificación promedio diploma
maestro alumno director prefecto
tiza gis gis gis
peluche muñeca carrito trenecito cubo
rompecabezas puzzle lego bloque ficha
canica yoyo trompo papalote cometa
baraja naipe dado ficha
canción verso estribillo coro melodía
ritmo tempo compás acorde nota
tambor flauta violín chelo arpa
trompeta saxofón clarinete oboe
batería bajo ukelele mandolina
cine película escena acto acto
teatro escenario telón butaca palco
museo cuadro estatua mural fresco
foto retrato selfie recorte
correo mensaje aviso recado nota
correo electrónico
parque banco fuente estatua kiosco
árbol rama hoja flor fruto semilla
raíz tronco corteza savia
nido huevo pico ala pluma cola
garra pata pezuña cuerno asta
aleta escama branquia
colmena miel cera polen
nube gota charco río
ola marea espuma coral
concha perla arena duna
faro puerto muelle dársena
ancla vela mástil timón
rueda eje cadena freno
motor gasolina diesel pila
batería cable enchufe
enchufe
puente viaducto
túnel paso
cruce
semaforo
camioneta
tractocamión
ambulancia patrulla
bomberos
sirena
hospital cama suero
jeringa venda gasa
pastilla jarabe
vitamina vacuna
fiebre tos gripe
resfriado alergia
herida moretón
yeso muleta silla
farmacia receta
dosis
clínica
consulta
turno ficha
sala espera
elevador
rampa
pasillo
recepción
doctor
enfermera
camilla
estetoscopio
termómetro
báscula
rayos
placa
análisis
laboratorio
muestra
resultado
alta
ingreso
visita
familiar
flor
globo
tarjeta
regalo
pastel
vela
fiesta
cumple
piñata
confeti
serpentina
globo
silbato
mariachi
banda
sonido
altavoz
bocina
micrófono
karaoke
baile
vals
cumbia
salsa
son
huapango
jarabe
zapateado
traje
charro
china
poblana
rebozo
sarape
huarache
sombrero
lazo
caballo
jaripeo
lienzo
toro
vaquero
espuela
silla
montura
rienda
freno
establo
paja
heno
maíz
silo
tractor
arado
surco
siembra
cosecha
riego
canal
acequia
noria
pozo
bomba
manguera
aspersor
invernadero
maceta
abono
composta
tierra
semilla
brote
tallo
hoja
flor
fruto
cosecha
canasta
costal
saco
cesta
canasto
huacal
caja
reja
cerca
alambre
poste
puerta
portón
candado
llave
perro
pastor
corral
gallina
huevo
leche
queso
mantequilla
crema
yogur
miel
panal
abeja
flor
polen
néctar
mariposa
colibrí
abejorro
libélula
grillo
rana
sapo
lagartija
camaleón
iguana
tortuga
serpiente
coralillo
cascabel
víbora
cocodrilo
caimán
río
laguna
charco
lodo
barro
piedra
canto
guijarro
arena
playa
ola
espuma
concha
caracol
cangrejo
gaviota
pelícano
delfín
ballena
tiburón
pez
red
anzuelo
caña
barco
lancha
remo
motor
faro
puerto
muelle
ancla
vela
viento
brisa
tormenta
nube
lluvia
arcoíris
sol
playa
toalla
sombrilla
bloqueador
sandalia
chancla
traje
baño
aleta
snorkel
máscara
tubo
arena
castillo
pala
cubeta
concha
estrella
mar
sal
ola
tabla
surf
ola
playa
hotel
cuarto
llave
cama
almohada
toalla
jabón
ducha
alberca
hamaca
palmera
coco
piña
jugo
horchata
jamaica
tamarindo
limón
naranja
agua
hielo
vaso
popote
servilleta
plato
taco
salsa
limón
cebolla
cilantro
rábano
pepino
aguacate
crema
queso
pollo
asada
pastor
suadero
tripa
bistec
chuleta
costilla
arrachera
carne
asador
carbón
leña
humo
pinza
espátula
parrilla
mesa
silla
mantel
jarra
vaso
botella
lata
abrebotellas
destapador
corcho
tapón
servilleta
servilletero
salero
pimentero
azucarera
lechera
tetera
cafetera
filtro
grano
molino
prensa
taza
platillo
cuchara
cucharita
tenedor
cuchillo
servilleta
servilleta
panera
canasta
pan
bolillo
mantequilla
mermelada
miel
cajeta
nutella
granola
cereal
leche
jugo
café
té
chocolate
atole
champurrado
tamal
bolillo
`.replace(/\s+/g, " ").trim();

function fold(text) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-zñü]/g, "");
}

const seen = new Set();
const words = [];
for (const raw of RAW.split(" ")) {
  const word = raw.trim().toLowerCase();
  if (!word) continue;
  if (word.length < 3 || word.length > 12) continue;
  if (!/^[a-záéíóúüñ]+$/i.test(word)) continue;
  const key = fold(word);
  if (key.length < 3 || seen.has(key)) continue;
  seen.add(key);
  words.push(word);
}

words.sort((a, b) => a.localeCompare(b, "es"));

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "backend", "src", "word-bank.json");
writeFileSync(dest, `${JSON.stringify(words, null, 2)}\n`);
console.log(`${words.length} palabras → ${dest}`);
if (words.length < 1250) {
  console.error(`Faltan ${1250 - words.length} palabras.`);
  process.exit(1);
}
