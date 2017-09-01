$(document).ready(function(){
  var slides = [];
  $("#pages").children("h1").each(function(index){
    var onepage = $(this).nextUntil("h1");
    var h1 = $(this).text().split("::");
    var meta = ["step", "1000", "1000", "0", "1"];
    if (h1 && h1[1]) {
      meta = h1[1].split(",");
    }
    var div = $("<div class='"+meta[0]+"' data-x='"+meta[1]+"' data-y='"+meta[2]+"' data-rotate='"+meta[3]+"' data-scale='"+meta[4]+"'></div>");
    div.append("<h1>"+h1[0]+"</h1>").append(onepage);
    $("#impress").append(div);
  });
  impress().init();
  $("#pages").remove();
});