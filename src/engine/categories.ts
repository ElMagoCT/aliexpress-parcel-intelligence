/** Inferred spend categories from item titles — heuristic keywords, first match wins. */
const RULES: [string, RegExp][] = [
  ['Electronics', /\b(usb|hdmi|cable|charger|adapter|bluetooth|earbuds?|headphones?|speaker|ssd|nvme|ram\b|cpu|gpu|arduino|esp32|esp8266|raspberry|sensor|module|pcb|microcontroller|stm32|led strip|power supply|battery|lipo|18650|multimeter|oscilloscope|soldering|resistor|capacitor|relay|servo|stepper|motor driver|display|oled|lcd|camera|webcam|microphone|router|antenna|smart watch|smartwatch|phone case|screen protector|keyboard|mouse|monitor|dongle|hub\b|sd card|flash drive|tf card|drone|fpv|gimbal)/i],
  ['Tools & Hardware', /\b(wrench|screwdriver|drill|bit set|pliers|hex|allen|socket|saw|clamp|vise|caliper|micrometer|tap|die|file|chisel|hammer|level|tape measure|ruler|bearing|bolt|screws?|nuts?|washers?|rivet|bracket|hinge|spring|shaft|coupling|pulley|belt|gear|linear rail|lead screw|aluminum extrusion|2020|3d printer|nozzle|hotend|filament|pla|petg|tpu|resin|cnc|end mill|router bit|glue|epoxy|tape|zip ties|heat shrink)/i],
  ['Robotics & FTC', /\b(rev\b|gobilda|goBILDA|ftc|frc|robot|chassis|omni|mecanum|encoder|odometry|servo|tetrix|vex|motor|gearbox|sprocket|chain|intake|slide|viper)/i],
  ['Clothing & Accessories', /\b(shirt|t-shirt|hoodie|jacket|coat|pants|jeans|shorts|dress|skirt|socks|shoes|sneakers|boots|sandals|hat|cap|beanie|scarf|gloves|belt|wallet|bag|backpack|purse|sunglasses|watch band|strap|jewelry|necklace|bracelet|ring|earrings)/i],
  ['Home & Kitchen', /\b(kitchen|knife|cutting board|spatula|mug|cup|bottle|thermos|storage|organizer|shelf|hook|lamp|light bulb|curtain|pillow|blanket|towel|rug|mat|vacuum|cleaner|brush|sponge|container|jar|planter|garden|seed|pot\b)/i],
  ['Automotive', /\b(car\b|auto|vehicle|tire|wheel|obd|dash cam|seat cover|steering|brake|headlight|wiper|motorcycle|bike|bicycle|helmet|scooter)/i],
  ['Toys & Games', /\b(toy|puzzle|lego|building blocks|figure|figurine|plush|board game|card game|dice|rc car|model kit|gundam|anime)/i],
  ['Beauty & Health', /\b(makeup|lipstick|nail|skin ?care|serum|mask|hair|comb|razor|trimmer|massage|toothbrush|vitamin|supplement|fitness|yoga|resistance band|dumbbell)/i],
  ['Crafts & Office', /\b(pen|pencil|notebook|sticker|marker|paint|brush|canvas|yarn|fabric|sewing|embroidery|bead|resin mold|stamp|paper|planner|desk|stationery)/i],
  ['Music', /\b(guitar|piano|keyboard stand|capo|pick|string|ukulele|violin|drum|midi|audio interface|tuner|metronome|pedal)/i],
];

export function inferCategory(title: string): string {
  for (const [cat, re] of RULES) if (re.test(title)) return cat;
  return 'Other';
}
